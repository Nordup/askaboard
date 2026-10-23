import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react'
import { isStroke, newItemId, stampChanged, type BoardDoc, type Removal } from '@shared/board-format'
import { isEditableTarget } from '../lib/keys'
import type { ToolId } from '../tools'
import {
  boardKeyAction,
  copySelectedStrokes,
  duplicateStrokes,
  hasInkClipboard,
  pasteStrokes,
  readInkClipboard,
  removeSelected,
  writeInkClipboard,
  type BoardKeyAction
} from './clipboard'
import {
  boardToScreen,
  clampZoom,
  screenToBoard,
  selectionBounds as boundsOfSelection,
  strokeBounds,
  strokeHitByCircle,
  strokeInsidePolygon,
  topStrokeAt,
  translateItems,
  unionRegions,
  zoomAt
} from './geometry'
import type { BoardHistory } from './history'
import { paintActive, paintItems } from './paint'
import type { BoardItem, Camera, Point, Region, StrokeItem } from './types'
import './board.css'

/**
 * The ink board. Ported from web/src/board/Board.tsx: the same pointer
 * routing (pen / mouse / touch, coalesced events, pressure, the pen's eraser
 * end, lasso, pan with Space or the middle button, wheel), without the tutor.
 */

export type ZoomStep = 'in' | 'out' | 'reset'

export interface BoardHandle {
  /** Zoom around the viewport centre. */
  zoomTo(zoom: number): void
  zoomBy(factor: number): void
  /**
   * One zoom step from the menu (⌘= ⌘- ⌘0). The page key handler zooms too;
   * a step that the other source made a moment ago is not repeated.
   */
  zoomStep(step: ZoomStep, source: 'menu' | 'key'): void
  /** Show all ink. */
  fit(): void
  /** The live board, with edits that are not saved yet. For the agent bridge. */
  liveState(): LiveBoardState
  /** Briefly outline a board region, so the learner sees what an agent looked at. */
  flash(rect: Region): void
  /** Window (client) CSS coordinates of a board point. Dev hook for scripts/drive.mjs. */
  boardToClient(point: Point): Point | null
  /** The canvas rect in window CSS pixels. Dev hook. */
  clientRect(): Region | null
  /** Pan (and zoom out if needed) so the board rect is in view with a margin. Keeps the camera when it already is. */
  reveal(rect: Region): void
}

export interface LiveBoardState {
  items: readonly BoardItem[]
  nextSeq: number
  camera: Camera
  /** The canvas size in CSS pixels. */
  viewport: Point
  selectedIds: readonly string[]
}

export interface BoardProps {
  doc: BoardDoc
  /** Per-board undo history. The parent keeps it across board switches. */
  history: BoardHistory
  /** null: fit the content when the viewport is known. */
  initialCamera: Camera | null
  tool: ToolId
  color: string
  /** Nominal pen width in board points. */
  width: number
  onDocChange(doc: BoardDoc): void
  onCameraChange(camera: Camera): void
  /** Items left the board (erase, cut, delete, undo). Each removal has its own seq. */
  onRemoved?(removed: Removal[]): void
  ref?: Ref<BoardHandle>
}

/** Highlighter strokes are this many times wider than pen strokes. */
const HIGHLIGHTER_SCALE = 4
/** Stroke eraser radius in screen pixels. */
const ERASE_RADIUS = 10
/** Grid pitch in board points. */
const GRID_PITCH = 24
/** How long the "an agent looked here" outline shows. */
const FLASH_MS = 1400

type DragKind = 'pan' | 'lasso' | 'move' | 'ink' | 'erase'

interface DragState {
  kind: DragKind
  pointerId: number
  start: Point
  last: Point
  points: Point[]
  startItems: BoardItem[]
  startCamera: Camera
  startSelectedIds: string[]
  startSelection: Region | null
  changed: boolean
  /** Lasso only: every pointer sample, in board coordinates. */
  lasso: Point[]
}

const cssPoint = (event: { clientX: number; clientY: number }, rect: DOMRect): Point => [event.clientX - rect.left, event.clientY - rect.top]

const sampleScreenDistance = 0.5
/** Selection box padding, in screen pixels. The padded box is the move handle. */
const SELECTION_PAD = 8
/** A lasso path smaller than this (screen pixels) is a tap. */
const TAP_SIZE = 6

function pressureOf(pointerType: string, pressure: number): number {
  if (pointerType !== 'pen') return 0.5
  return pressure > 0 ? pressure : 0.5
}

/** Dot grid style: pans and scales with the camera, fades when zoomed far out. */
function gridStyle(camera: Camera, viewport: Point): CSSProperties {
  let size = GRID_PITCH * camera.zoom
  while (size > 72) size /= 2
  const alpha = 0.07 * Math.min(1, Math.max(0, (camera.zoom - 0.3) / 0.35))
  const origin = boardToScreen([0, 0], viewport, camera)
  const offset = (value: number): number => (((value - size / 2) % size) + size) % size
  return {
    '--grid-size': `${size}px`,
    '--grid-x': `${offset(origin[0])}px`,
    '--grid-y': `${offset(origin[1])}px`,
    '--grid-alpha': alpha.toFixed(3)
  } as CSSProperties
}

export function Board({ doc, history, initialCamera, tool, color, width, onDocChange, onCameraChange, onRemoved, ref }: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const activeInkRef = useRef<HTMLCanvasElement>(null)
  const eraserRef = useRef<HTMLDivElement>(null)

  const itemsRef = useRef<BoardItem[]>(doc.items)
  const nextSeqRef = useRef(doc.nextSeq)
  const extraRef = useRef(doc.extra)
  const cameraRef = useRef<Camera>(initialCamera ?? { center: [0, 0], zoom: 1 })
  const needsFitRef = useRef(initialCamera === null)
  const viewportRef = useRef<Point>([1, 1])
  const activeRef = useRef<StrokeItem | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const selectedIdsRef = useRef<string[]>([])
  const pasteAnchorRef = useRef<Point | null>(null)
  const spaceRef = useRef(false)
  const paintFrameRef = useRef<number | null>(null)
  const dirtyLayersRef = useRef({ committed: false, active: false })

  const [camera, setCamera] = useState<Camera>(cameraRef.current)
  const [viewport, setViewport] = useState<Point>([1, 1])
  const [lassoPoints, setLassoPoints] = useState<Point[] | null>(null)
  const [selection, setSelection] = useState<Region | null>(null)
  const [panReady, setPanReady] = useState(false)
  const [panning, setPanning] = useState(false)
  const [flashRect, setFlashRect] = useState<{ rect: Region; id: number } | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onDocChangeRef = useRef(onDocChange)
  const onCameraChangeRef = useRef(onCameraChange)
  onDocChangeRef.current = onDocChange
  onCameraChangeRef.current = onCameraChange
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved

  // ---------- Painting (batched to one frame) ----------

  const requestPaint = useCallback((layers: { committed?: boolean; active?: boolean }) => {
    if (layers.committed) dirtyLayersRef.current.committed = true
    if (layers.active) dirtyLayersRef.current.active = true
    if (paintFrameRef.current !== null) return
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = null
      const dirty = dirtyLayersRef.current
      dirtyLayersRef.current = { committed: false, active: false }
      if (dirty.committed)
        paintItems(inkRef.current, itemsRef.current, viewportRef.current, cameraRef.current, new Set(selectedIdsRef.current))
      if (dirty.active) paintActive(activeInkRef.current, activeRef.current, viewportRef.current, cameraRef.current)
    })
  }, [])
  useEffect(
    () => () => {
      if (paintFrameRef.current !== null) cancelAnimationFrame(paintFrameRef.current)
    },
    []
  )

  // ---------- Camera ----------

  const applyCamera = useCallback(
    (next: Camera) => {
      cameraRef.current = next
      setCamera(next)
      requestPaint({ committed: true, active: true })
      onCameraChangeRef.current(next)
    },
    [requestPaint]
  )

  const fit = useCallback(() => {
    const [vw, vh] = viewportRef.current
    const content = unionRegions(itemsRef.current.filter(isStroke).map(strokeBounds))
    if (!content) {
      applyCamera({ center: [0, 0], zoom: 1 })
      return
    }
    const zoom = clampZoom(Math.min(1, (vw * 0.8) / Math.max(1, content.width), (vh * 0.7) / Math.max(1, content.height)))
    applyCamera({ center: [content.x + content.width / 2, content.y + content.height / 2], zoom })
  }, [applyCamera])

  const lastStepRef = useRef<{ step: ZoomStep; source: 'menu' | 'key'; at: number } | null>(null)
  const zoomStep = useCallback(
    (step: ZoomStep, source: 'menu' | 'key') => {
      const now = performance.now()
      const last = lastStepRef.current
      // One keypress can reach both the page and the menu accelerator: zoom once.
      if (last && last.step === step && last.source !== source && now - last.at < 250) {
        lastStepRef.current = null
        return
      }
      lastStepRef.current = { step, source, at: now }
      const [vw, vh] = viewportRef.current
      const current = cameraRef.current
      const zoom = step === 'reset' ? 1 : step === 'out' ? current.zoom / 1.25 : current.zoom * 1.25
      applyCamera(zoomAt(current, [vw / 2, vh / 2], viewportRef.current, zoom))
    },
    [applyCamera]
  )

  useImperativeHandle(
    ref,
    () => ({
      zoomStep,
      zoomTo: (zoom) => {
        const [vw, vh] = viewportRef.current
        applyCamera(zoomAt(cameraRef.current, [vw / 2, vh / 2], viewportRef.current, zoom))
      },
      zoomBy: (factor) => {
        const [vw, vh] = viewportRef.current
        applyCamera(zoomAt(cameraRef.current, [vw / 2, vh / 2], viewportRef.current, cameraRef.current.zoom * factor))
      },
      fit,
      liveState: () => ({
        items: itemsRef.current,
        nextSeq: nextSeqRef.current,
        camera: cameraRef.current,
        viewport: viewportRef.current,
        selectedIds: selectedIdsRef.current
      }),
      boardToClient: (point) => {
        const host = hostRef.current
        if (!host) return null
        const rect = host.getBoundingClientRect()
        const screen = boardToScreen(point, viewportRef.current, cameraRef.current)
        return [rect.left + screen[0], rect.top + screen[1]]
      },
      clientRect: () => {
        const rect = hostRef.current?.getBoundingClientRect()
        return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
      },
      reveal: (rect) => {
        const [vw, vh] = viewportRef.current
        const current = cameraRef.current
        const margin = 80 / current.zoom
        const halfW = vw / 2 / current.zoom
        const halfH = vh / 2 / current.zoom
        const inView =
          rect.x - margin >= current.center[0] - halfW &&
          rect.x + rect.width + margin <= current.center[0] + halfW &&
          rect.y - margin >= current.center[1] - halfH &&
          rect.y + rect.height + margin <= current.center[1] + halfH
        if (inView) return
        const zoom = clampZoom(Math.min(current.zoom, (vw - 160) / Math.max(1, rect.width), (vh - 160) / Math.max(1, rect.height)))
        applyCamera({ center: [rect.x + rect.width / 2, rect.y + rect.height / 2], zoom })
      },
      flash: (rect) => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
        setFlashRect({ rect, id: performance.now() })
        flashTimerRef.current = setTimeout(() => setFlashRect(null), FLASH_MS)
      }
    }),
    [applyCamera, fit, zoomStep]
  )
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    },
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const next: Point = [Math.max(1, rect.width), Math.max(1, rect.height)]
      viewportRef.current = next
      setViewport(next)
      if (needsFitRef.current) {
        needsFitRef.current = false
        fit()
      }
      requestPaint({ committed: true, active: true })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [fit, requestPaint])

  // ---------- Items ----------

  const emit = useCallback(() => {
    onDocChangeRef.current({ nextSeq: nextSeqRef.current, items: itemsRef.current, extra: extraRef.current })
  }, [])

  /** Select strokes by id. Ids that are not on the board are dropped. */
  const setSelectedIds = useCallback(
    (ids: string[]) => {
      const present = new Set(itemsRef.current.filter(isStroke).map((stroke) => stroke.id))
      const kept = ids.filter((id) => present.has(id))
      if (kept.length === 0 && selectedIdsRef.current.length === 0) return
      selectedIdsRef.current = kept
      setSelection(kept.length ? boundsOfSelection(itemsRef.current, kept) : null)
      requestPaint({ committed: true })
    },
    [requestPaint]
  )

  /** Commit an edit: record undo, stamp seq on new or changed items, notify. */
  const commitItems = useCallback(
    (next: BoardItem[], snapshot: BoardItem[] = itemsRef.current) => {
      if (next.length === snapshot.length && next.every((item, i) => item === snapshot[i])) {
        itemsRef.current = snapshot
        return
      }
      history.record(snapshot)
      const stamped = stampChanged(snapshot, next, nextSeqRef.current)
      itemsRef.current = stamped.items
      nextSeqRef.current = stamped.nextSeq
      if (stamped.removed.length) onRemovedRef.current?.(stamped.removed)
      requestPaint({ committed: true })
      emit()
    },
    [emit, history, requestPaint]
  )

  /** Undo or redo: the restored items count as changed, so they get a new seq. */
  const restore = useCallback(
    (snapshot: BoardItem[] | null) => {
      if (!snapshot) return
      const stamped = stampChanged(itemsRef.current, snapshot, nextSeqRef.current)
      itemsRef.current = stamped.items
      nextSeqRef.current = stamped.nextSeq
      if (stamped.removed.length) onRemovedRef.current?.(stamped.removed)
      setSelectedIds([])
      requestPaint({ committed: true })
      emit()
    },
    [emit, requestPaint, setSelectedIds]
  )
  const undo = useCallback(() => restore(history.undo(itemsRef.current)), [history, restore])
  const redo = useCallback(() => restore(history.redo(itemsRef.current)), [history, restore])

  const eraseAt = useCallback(
    (screen: Point) => {
      const point = screenToBoard(screen, viewportRef.current, cameraRef.current)
      const radius = ERASE_RADIUS / cameraRef.current.zoom
      const kept = itemsRef.current.filter((item) => !(isStroke(item) && strokeHitByCircle(item, point, radius)))
      if (kept.length !== itemsRef.current.length) {
        itemsRef.current = kept
        if (dragRef.current) dragRef.current.changed = true
        if (selectedIdsRef.current.length) setSelectedIds([])
        requestPaint({ committed: true })
      }
    },
    [requestPaint, setSelectedIds]
  )

  // Leaving the select tool clears the selection; leaving the eraser hides its cursor.
  useEffect(() => {
    if (tool !== 'select') setSelectedIds([])
    if (tool !== 'eraser' && eraserRef.current) eraserRef.current.style.opacity = '0'
  }, [tool, setSelectedIds])

  // ---------- Pointer input ----------

  const moveEraserCursor = (screen: Point | null): void => {
    const cursor = eraserRef.current
    if (!cursor) return
    if (!screen) {
      cursor.style.opacity = '0'
      return
    }
    cursor.style.opacity = '1'
    cursor.style.transform = `translate(${screen[0] - ERASE_RADIUS}px, ${screen[1] - ERASE_RADIUS}px)`
  }

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const penEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
    if (event.button === 2 && !penEraser) return
    const host = hostRef.current
    if (!host) return
    if (dragRef.current) {
      // A second finger or pen during a drag is ignored; a stale drag of the same pointer is dropped.
      if (dragRef.current.pointerId !== event.pointerId) return
      cancelDrag()
    }
    // Drawing ends any text editing (for example a board rename).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== host) document.activeElement.blur()
    const rect = host.getBoundingClientRect()
    const screen = cssPoint(event, rect)
    const viewportNow = viewportRef.current
    const startBoard = screenToBoard(screen, viewportNow, cameraRef.current)
    pasteAnchorRef.current = startBoard

    const shouldPan = !penEraser && (event.button === 1 || spaceRef.current || event.pointerType === 'touch')
    const bounds = selectedIdsRef.current.length ? boundsOfSelection(itemsRef.current, selectedIdsRef.current) : null
    const topLeft = bounds ? boardToScreen([bounds.x, bounds.y], viewportNow, cameraRef.current) : null
    const zoom = cameraRef.current.zoom
    const inSelection = Boolean(
      bounds &&
        topLeft &&
        screen[0] >= topLeft[0] - SELECTION_PAD &&
        screen[0] <= topLeft[0] + bounds.width * zoom + SELECTION_PAD &&
        screen[1] >= topLeft[1] - SELECTION_PAD &&
        screen[1] <= topLeft[1] + bounds.height * zoom + SELECTION_PAD
    )
    const kind: DragKind = shouldPan
      ? 'pan'
      : penEraser || tool === 'eraser'
        ? 'erase'
        : tool === 'select'
          ? inSelection
            ? 'move'
            : 'lasso'
          : 'ink'

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture may be unavailable.
    }
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      start: screen,
      last: screen,
      points: [screen],
      startItems: itemsRef.current,
      startCamera: cameraRef.current,
      startSelectedIds: [...selectedIdsRef.current],
      startSelection: bounds,
      changed: false,
      lasso: [startBoard]
    }
    event.preventDefault()

    if (kind === 'pan') setPanning(true)
    else if (kind === 'ink') {
      const highlighter = tool === 'highlighter'
      activeRef.current = {
        id: newItemId(),
        kind: 'stroke',
        seq: 0,
        tool: highlighter ? 'highlighter' : 'pen',
        color,
        width: width * (highlighter ? HIGHLIGHTER_SCALE : 1),
        points: [[startBoard[0], startBoard[1], pressureOf(event.pointerType, event.pressure)]]
      }
      requestPaint({ active: true })
    } else if (kind === 'erase') {
      moveEraserCursor(screen)
      eraseAt(screen)
    } else if (kind === 'lasso') {
      setLassoPoints([startBoard])
    }
  }

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const screen = cssPoint(event, rect)
    const drag = dragRef.current
    const penEraserHover = event.pointerType === 'pen' && (event.buttons & 32) !== 0
    if ((tool === 'eraser' || penEraserHover || drag?.kind === 'erase') && event.pointerType !== 'touch') moveEraserCursor(screen)

    if (!drag && tool === 'select') {
      const bounds = selectedIdsRef.current.length ? boundsOfSelection(itemsRef.current, selectedIdsRef.current) : null
      const topLeft = bounds ? boardToScreen([bounds.x, bounds.y], viewportRef.current, cameraRef.current) : null
      const zoom = cameraRef.current.zoom
      const over = Boolean(
        bounds &&
          topLeft &&
          screen[0] >= topLeft[0] - SELECTION_PAD &&
          screen[0] <= topLeft[0] + bounds.width * zoom + SELECTION_PAD &&
          screen[1] >= topLeft[1] - SELECTION_PAD &&
          screen[1] <= topLeft[1] + bounds.height * zoom + SELECTION_PAD
      )
      host.dataset.overSelection = over ? 'true' : 'false'
    }
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta: Point = [screen[0] - drag.last[0], screen[1] - drag.last[1]]
    drag.last = screen

    if (drag.kind === 'pan') {
      const current = cameraRef.current
      applyCamera({ ...current, center: [current.center[0] - delta[0] / current.zoom, current.center[1] - delta[1] / current.zoom] })
    } else if (drag.kind === 'ink' && activeRef.current) {
      const stroke = activeRef.current
      const native = event.nativeEvent
      const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
      const minDistance = sampleScreenDistance / cameraRef.current.zoom
      for (const sample of samples.length ? samples : [native]) {
        const point = screenToBoard(cssPoint(sample, rect), viewportRef.current, cameraRef.current)
        const last = stroke.points[stroke.points.length - 1]
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < minDistance) continue
        stroke.points.push([point[0], point[1], pressureOf(event.pointerType, sample.pressure)])
      }
      requestPaint({ active: true })
    } else if (drag.kind === 'erase') {
      eraseAt(screen)
    } else if (drag.kind === 'move') {
      const zoom = cameraRef.current.zoom
      const boardDelta: Point = [(screen[0] - drag.start[0]) / zoom, (screen[1] - drag.start[1]) / zoom]
      drag.changed = drag.changed || boardDelta[0] !== 0 || boardDelta[1] !== 0
      itemsRef.current = translateItems(drag.startItems, new Set(selectedIdsRef.current), boardDelta)
      setSelection(boundsOfSelection(itemsRef.current, selectedIdsRef.current))
      requestPaint({ committed: true })
    } else if (drag.kind === 'lasso') {
      const native = event.nativeEvent
      const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
      for (const sample of samples.length ? samples : [native]) {
        const sampleScreen = cssPoint(sample, rect)
        drag.points.push(sampleScreen)
        drag.lasso.push(screenToBoard(sampleScreen, viewportRef.current, cameraRef.current))
      }
      setLassoPoints([...drag.lasso])
    }
    event.preventDefault()
  }

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    const host = hostRef.current
    const screen = host ? cssPoint(event, host.getBoundingClientRect()) : drag.last

    if (drag.kind === 'ink' && activeRef.current) {
      const stroke = activeRef.current
      const end = screenToBoard(screen, viewportRef.current, cameraRef.current)
      const last = stroke.points[stroke.points.length - 1]
      if (last[0] !== end[0] || last[1] !== end[1]) stroke.points.push([end[0], end[1], last[2]])
      activeRef.current = null
      commitItems([...itemsRef.current, stroke])
      requestPaint({ active: true })
    } else if (drag.kind === 'pan') {
      setPanning(false)
    } else if ((drag.kind === 'erase' || drag.kind === 'move') && drag.changed) {
      const ids = selectedIdsRef.current
      commitItems(itemsRef.current, drag.startItems)
      // Moved strokes got a new seq (new objects): keep them selected by id.
      if (drag.kind === 'move') setSelectedIds(ids)
    } else if (drag.kind === 'lasso') {
      drag.points.push(screen)
      drag.lasso.push(screenToBoard(screen, viewportRef.current, cameraRef.current))
      const xs = drag.points.map((point) => point[0])
      const ys = drag.points.map((point) => point[1])
      const isTap = Math.max(...xs) - Math.min(...xs) < TAP_SIZE && Math.max(...ys) - Math.min(...ys) < TAP_SIZE
      if (isTap) {
        // A tap selects the stroke under it, or clears the selection on empty canvas.
        const hit = topStrokeAt(itemsRef.current, drag.lasso[0], TAP_SIZE / cameraRef.current.zoom)
        setSelectedIds(hit ? [hit.id] : [])
      } else {
        const polygon = drag.lasso
        const selected = itemsRef.current.filter((item): item is StrokeItem => isStroke(item) && strokeInsidePolygon(item, polygon))
        setSelectedIds(selected.map((stroke) => stroke.id))
      }
      setLassoPoints(null)
    }
    if (drag.kind === 'erase' && tool !== 'eraser') moveEraserCursor(null)
  }

  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    cancelDrag()
  }

  const cancelDrag = (): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    activeRef.current = null
    if (drag.kind === 'move' || drag.kind === 'erase') {
      itemsRef.current = drag.startItems
      requestPaint({ committed: true })
    }
    if (drag.kind === 'move' || drag.kind === 'lasso') {
      selectedIdsRef.current = drag.startSelectedIds
      setSelection(drag.startSelection)
      requestPaint({ committed: true })
    }
    if (drag.kind === 'pan') {
      applyCamera(drag.startCamera)
      setPanning(false)
    }
    setLassoPoints(null)
    requestPaint({ active: true })
  }

  // ---------- Wheel: trackpad pan, pinch zoom, ⌘ + scroll zoom ----------

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current[1] : 1
      let dx = event.deltaX * scale
      let dy = event.deltaY * scale
      const current = cameraRef.current
      if (event.ctrlKey || event.metaKey) {
        // A trackpad pinch arrives as ctrl + wheel with small deltas.
        const speed = event.ctrlKey && !event.metaKey ? 0.01 : 0.002
        const point = cssPoint(event, host.getBoundingClientRect())
        applyCamera(zoomAt(current, point, viewportRef.current, current.zoom * Math.exp(-dy * speed)))
        return
      }
      if (event.shiftKey && dx === 0) {
        dx = dy
        dy = 0
      }
      applyCamera({ ...current, center: [current.center[0] + dx / current.zoom, current.center[1] + dy / current.zoom] })
    }
    host.addEventListener('wheel', wheel, { passive: false })
    return () => host.removeEventListener('wheel', wheel)
  }, [applyCamera])

  // ---------- Keyboard ----------

  const applyAction = (action: BoardKeyAction): void => {
    const ids = [...selectedIdsRef.current]
    if (action === 'undo') undo()
    else if (action === 'redo') redo()
    else if (action === 'copy' || action === 'cut') {
      const copied = copySelectedStrokes(itemsRef.current, ids)
      if (copied.length) writeInkClipboard(copied)
      if (action === 'cut' && copied.length) {
        commitItems(removeSelected(itemsRef.current, ids))
        setSelectedIds([])
      }
    } else if (action === 'delete') {
      commitItems(removeSelected(itemsRef.current, ids))
      setSelectedIds([])
    } else if (action === 'duplicate' || action === 'paste') {
      const result =
        action === 'duplicate'
          ? duplicateStrokes(itemsRef.current, ids)
          : pasteStrokes(itemsRef.current, readInkClipboard(), pasteAnchorRef.current ?? cameraRef.current.center)
      if (result.insertedIds.length) {
        commitItems(result.items)
        setSelectedIds(result.insertedIds)
        if (action === 'paste') pasteAnchorRef.current = null
      }
    }
  }
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (dragRef.current) cancelDrag()
      else if (selectedIdsRef.current.length) setSelectedIds([])
      else return
      event.preventDefault()
      return
    }
    const modified = event.metaKey || event.ctrlKey
    if (modified && !event.altKey && (event.key === '0' || event.key === '=' || event.key === '+' || event.key === '-')) {
      event.preventDefault()
      zoomStep(event.key === '0' ? 'reset' : event.key === '-' ? 'out' : 'in', 'key')
      return
    }
    if (dragRef.current) return
    const action = boardKeyAction(event, { hasSelection: selectedIdsRef.current.length > 0, hasClipboard: hasInkClipboard() })
    if (action) {
      event.preventDefault()
      applyAction(action)
    }
  }

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      if (event.code === 'Space' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        if (!spaceRef.current) {
          spaceRef.current = true
          setPanReady(true)
        }
        return
      }
      keyHandlerRef.current(event)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        spaceRef.current = false
        setPanReady(false)
      }
    }
    const blur = (): void => {
      spaceRef.current = false
      setPanReady(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // ---------- Render ----------

  const selectionTopLeft = selection ? boardToScreen([selection.x, selection.y], viewport, camera) : null
  const flashTopLeft = flashRect ? boardToScreen([flashRect.rect.x, flashRect.rect.y], viewport, camera) : null
  const cursorTool = panning ? 'panning' : panReady ? 'pan' : tool

  return (
    <div
      ref={hostRef}
      className="board"
      data-tool={cursorTool}
      style={gridStyle(camera, viewport)}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onPointerLeave={() => {
        if (!dragRef.current) moveEraserCursor(null)
      }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label="Board canvas"
    >
      <canvas className="board__ink" ref={inkRef} />
      <canvas className="board__active" ref={activeInkRef} aria-hidden="true" />
      {lassoPoints && lassoPoints.length > 1 && (
        <svg className="board__lasso" viewBox={`0 0 ${viewport[0]} ${viewport[1]}`} aria-hidden="true">
          {/* A polygon, so the closing segment back to the start shows while dragging. */}
          <polygon points={lassoPoints.map((point) => boardToScreen(point, viewport, camera).join(',')).join(' ')} />
        </svg>
      )}
      {selection && selectionTopLeft && (
        <div
          className="board__selection"
          style={{
            left: selectionTopLeft[0] - SELECTION_PAD,
            top: selectionTopLeft[1] - SELECTION_PAD,
            width: selection.width * camera.zoom + SELECTION_PAD * 2,
            height: selection.height * camera.zoom + SELECTION_PAD * 2
          }}
        />
      )}
      {flashRect && flashTopLeft && (
        <div
          key={flashRect.id}
          className="board__flash"
          style={{
            left: flashTopLeft[0],
            top: flashTopLeft[1],
            width: flashRect.rect.width * camera.zoom,
            height: flashRect.rect.height * camera.zoom,
            animationDuration: `${FLASH_MS}ms`
          }}
          aria-hidden="true"
        />
      )}
      <div className="board__eraser" ref={eraserRef} style={{ width: ERASE_RADIUS * 2, height: ERASE_RADIUS * 2 }} />
    </div>
  )
}
