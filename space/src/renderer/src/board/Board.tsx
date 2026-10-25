import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { isContent, isFrame, isInk, isKnown, newItemId, stampChanged, type Author, type BoardDoc, type NodeStyle, type Removal } from '@shared/board-format'
import { isEditableTarget } from '../lib/keys'
import type { ToolId } from '../tools'
import { boardKeyAction, hasNodeClipboard, readNodeClipboard, writeNodeClipboard, type BoardKeyAction } from './clipboard'
import { ContentLayer, measureContent, type ContentContext } from './content'
import {
  boardToScreen,
  clampZoom,
  inkBounds,
  inkLocalBounds,
  overlapShare,
  regionContains,
  regionInsidePolygon,
  screenToBoard,
  strokeHitByCircle,
  strokeInsidePolygon,
  zoomAt
} from './geometry'
import type { BoardHistory } from './history'
import { paintActive, paintItems, type PaintInk } from './paint'
import { applyElementOverride, clearElementOverride, type PlaybackFrame } from './playback'
import {
  addInkLayout,
  boundsOf,
  buildIndex,
  contentAt,
  copySubtrees,
  inkAt,
  inkOffset,
  inkPaintOrder,
  isFlowed,
  moveNodes,
  normalizeInk,
  outermost,
  parentKey,
  removeNodes,
  ROOT,
  selectTarget,
  topLevelOf,
  zAbove,
  type LayoutMap,
  type SceneIndex
} from './scene'
import type { BoardNode, Camera, ContentNode, InkNode, LayoutBox, Point, Region, TextNode } from './types'
import './board.css'

/**
 * The board: one document of nodes. Content nodes (frames, text, svg,
 * images) are DOM in the content layer; ink is on the canvas above it, with
 * the same camera. Pointer routing (pen / mouse / touch, coalesced events,
 * pressure, the pen's eraser end, lasso, pan with Space or the middle button,
 * wheel) is ported from web/src/board/Board.tsx.
 *
 * The layout cache (`layoutRef`: id → world box) is the one source for hit
 * testing, selection boxes, lasso, ink parenting and agent bounds. Content
 * entries are measured from the DOM after each render; ink entries come from
 * the points.
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
  /** Show all nodes. */
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
  /** Glide the camera to `camera` over `ms`. Any learner pan, zoom or pointer input stops the glide. */
  animateTo(camera: Camera, ms?: number): void
  /** Restyle the selection with a palette colour. Returns false when nothing is selected. */
  applyColor(color: string): boolean
  /** Restyle selected ink with a palette width. Returns false when no ink is selected. */
  applyWidth(width: number): boolean
  /**
   * Commit an agent edit as one undo step, then lay it out before returning,
   * so the layout cache has the new nodes' bounds.
   */
  agentCommit(next: BoardNode[]): void
  /**
   * Change the last agent commit without a new undo step (a post-layout
   * correction of the same write), then lay it out before returning.
   */
  agentAmend(next: BoardNode[]): void
  /** Measure the content layer now (after images load). */
  remeasure(): void
  /** Show agent presence outlines on these top-level nodes. */
  setPresence(entries: PresenceEntry[]): void
  /** Select every top-level node and all loose ink (⌘A on the canvas). */
  selectAll(): void
  /**
   * Show a moment of live-scene playback (see playback.ts), or end it with
   * null. Content elements change before this returns, so a scene committed
   * in the same task never shows its final state first.
   */
  setPlayback(frame: PlaybackFrame | null): void
}

export interface PresenceEntry {
  id: string
  label: string
}

export interface LiveBoardState {
  nodes: readonly BoardNode[]
  nextSeq: number
  camera: Camera
  /** The canvas size in CSS pixels. */
  viewport: Point
  selectedIds: readonly string[]
  /** World bounds of a node, from the layout cache. */
  bounds(id: string): Region | null
  /** Every ink node with its world offset, in draw order. */
  inks(): PaintInk[]
  /** The layout cache: world boxes and child origins. */
  layout(): ReadonlyMap<string, LayoutBox>
  /** Who last changed a node in this app session ("learner" or "agent"), when known. */
  editor(id: string): Author | undefined
  /** When a node was last committed in this app session (epoch ms), when known. */
  changedAt(id: string): number | undefined
  /** When the learner last finished a stroke (epoch ms, 0 = not in this session). */
  learnerInkAt: number
  /** True while the learner draws a stroke. */
  drawing: boolean
  /** When the learner last panned or zoomed the view (epoch ms, 0 = not in this session). */
  learnerViewAt: number
  /** The learner's current pen colour. */
  inkColor: string
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
  /** Nodes left the board (erase, cut, delete, undo). Each removal has its own seq. */
  onRemoved?(removed: Removal[]): void
  ref?: Ref<BoardHandle>
}

/** Highlighter strokes are this many times wider than pen strokes. */
export const HIGHLIGHTER_SCALE = 4
/** Stroke eraser radius in screen pixels. */
const ERASE_RADIUS = 10
/** Grid pitch in board points. */
const GRID_PITCH = 24
/** How long the "an agent looked here" outline shows. */
const FLASH_MS = 1400
/** Share of a new stroke's bounds that must lie inside a frame to join it. */
const PARENT_SHARE = 0.6
/** Duplicates land this far from the original (board points). */
const DUPLICATE_OFFSET = 20
/** The smallest size a resize makes (board points). */
const MIN_SIZE = 8
/** Font size of a new text node (board points). */
const NEW_TEXT_SIZE = 20

type DragKind = 'pan' | 'lasso' | 'move' | 'ink' | 'erase' | 'resize' | 'none'
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface DragState {
  kind: DragKind
  pointerId: number
  start: Point
  last: Point
  points: Point[]
  startNodes: BoardNode[]
  startCamera: Camera
  startSelectedIds: string[]
  changed: boolean
  /** Lasso only: every pointer sample, in board coordinates. */
  lasso: Point[]
  /** Move: the ids that move. */
  moveIds?: Set<string>
  /** Move: the clicked node, to select alone when the press was a click. */
  clicked?: string
  /** Lasso with Shift: add to the selection. */
  additive?: boolean
  /** Resize: the node, the handle and the start box. */
  resize?: { id: string; handle: Handle; box: LayoutBox }
}

interface EditingState {
  id: string
  /** The nodes before editing started (a new text node is not in them). */
  snapshot: BoardNode[]
  initial: string
}

const cssPoint = (event: { clientX: number; clientY: number }, rect: DOMRect): Point => [event.clientX - rect.left, event.clientY - rect.top]

const sampleScreenDistance = 0.5
/** Selection box padding, in screen pixels. The padded box is the move handle. */
const SELECTION_PAD = 6
/** A lasso path smaller than this (screen pixels) is a tap. */
const TAP_SIZE = 6

const px = (value: number): string => `${Math.round(value * 10) / 10}px`

function pressureOf(pointerType: string, pressure: number): number {
  if (pointerType !== 'pen') return 0.5
  return pressure > 0 ? pressure : 0.5
}

/** True when `target` is a text editor that can still scroll by (dx, dy). */
function canScroll(target: EventTarget | null, dx: number, dy: number): boolean {
  if (!(target instanceof HTMLTextAreaElement)) return false
  const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = target
  if (dy > 0 && scrollTop + clientHeight < scrollHeight - 1) return true
  if (dy < 0 && scrollTop > 0) return true
  if (dx > 0 && scrollLeft + clientWidth < scrollWidth - 1) return true
  if (dx < 0 && scrollLeft > 0) return true
  return false
}

/** Cancel a pending animation frame and clear its slot, so the next request schedules a new one. */
function cancelFrame(slot: { current: number | null }): void {
  if (slot.current !== null) cancelAnimationFrame(slot.current)
  slot.current = null
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

/** Which handles a node shows. Text resizes its width only; flowed nodes keep their place. */
function handlesFor(node: BoardNode | undefined): Handle[] {
  if (!node || !isKnown(node) || node.locked) return []
  if (node.kind === 'text') return ['e', 'w']
  return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
}

/** The box after dragging a handle by a world delta. */
function resizedBox(box: Region, handle: Handle, delta: Point, keepAspect: boolean): Region {
  let left = box.x
  let top = box.y
  let right = box.x + box.width
  let bottom = box.y + box.height
  if (handle.includes('w')) left = Math.min(right - MIN_SIZE, left + delta[0])
  if (handle.includes('e')) right = Math.max(left + MIN_SIZE, right + delta[0])
  if (handle.includes('n')) top = Math.min(bottom - MIN_SIZE, top + delta[1])
  if (handle.includes('s')) bottom = Math.max(top + MIN_SIZE, bottom + delta[1])
  if (keepAspect && handle.length === 2 && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height
    const width = right - left
    const height = bottom - top
    if (width / height > ratio) {
      const next = height * ratio
      if (handle.includes('w')) left = right - next
      else right = left + next
    } else {
      const next = width / ratio
      if (handle.includes('n')) top = bottom - next
      else bottom = top + next
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function Board({ doc, history, initialCamera, tool, color, width, onDocChange, onCameraChange, onRemoved, ref }: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const activeInkRef = useRef<HTMLCanvasElement>(null)
  const eraserRef = useRef<HTMLDivElement>(null)
  const contentRootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const nodesRef = useRef<BoardNode[]>(doc.nodes)
  const indexRef = useRef<SceneIndex>(buildIndex(doc.nodes))
  const layoutRef = useRef<LayoutMap>(new Map())
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const nextSeqRef = useRef(doc.nextSeq)
  const extraRef = useRef(doc.extra)
  const cameraRef = useRef<Camera>(initialCamera ?? { center: [0, 0], zoom: 1 })
  /** The camera the content layer's transform shows now. */
  const domCameraRef = useRef<Camera>(cameraRef.current)
  const needsFitRef = useRef(initialCamera === null)
  const viewportRef = useRef<Point>([1, 1])
  const activeRef = useRef<InkNode | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const selectedIdsRef = useRef<string[]>([])
  const pasteAnchorRef = useRef<Point | null>(null)
  const spaceRef = useRef(false)
  const paintFrameRef = useRef<number | null>(null)
  const dirtyLayersRef = useRef({ committed: false, active: false })
  const editingRef = useRef<EditingState | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  /** Live-scene playback: the frame shown now, the ghost layer, and the elements it changed. */
  const playbackRef = useRef<PlaybackFrame | null>(null)
  const ghostRootRef = useRef<HTMLDivElement>(null)
  const ghostElementsRef = useRef(new Map<string, HTMLElement>())
  const ghostNodesRef = useRef<readonly BoardNode[]>([])
  const playbackTouchedRef = useRef(new Set<HTMLElement>())
  const [ghostIndex, setGhostIndex] = useState<SceneIndex | null>(null)

  const [camera, setCamera] = useState<Camera>(cameraRef.current)
  const [viewport, setViewport] = useState<Point>([1, 1])
  const [index, setIndex] = useState<SceneIndex>(indexRef.current)
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [selectedIds, setSelectedIdsState] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lassoPoints, setLassoPoints] = useState<Point[] | null>(null)
  const [panReady, setPanReady] = useState(false)
  const [panning, setPanning] = useState(false)
  const [flashRect, setFlashRect] = useState<{ rect: Region; id: number } | null>(null)
  const [presence, setPresence] = useState<PresenceEntry[]>([])
  const editorsRef = useRef(new Map<string, Author>())
  const timesRef = useRef(new Map<string, number>())
  const lastStrokeAtRef = useRef(0)
  const learnerViewAtRef = useRef(0)
  /** Bumped by learner input: a running camera glide stops when it changes. */
  const glideRef = useRef(0)
  const colorRef = useRef(color)
  colorRef.current = color
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onDocChangeRef = useRef(onDocChange)
  const onCameraChangeRef = useRef(onCameraChange)
  onDocChangeRef.current = onDocChange
  onCameraChangeRef.current = onCameraChange
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved

  // ---------- Painting (batched to one frame) ----------

  const paintInks = useCallback((): PaintInk[] => {
    const layout = layoutRef.current
    const index = indexRef.current
    return inkPaintOrder(index).map((node) => {
      const box = layout.get(node.id)
      return { node, offset: box ? [box.ox, box.oy] : inkOffset(node, index.byId, layout) }
    })
  }, [])

  const applyContentTransform = useCallback(() => {
    const root = contentRootRef.current
    if (!root) return
    const cam = cameraRef.current
    const [vw, vh] = viewportRef.current
    root.style.transform = `translate(${vw / 2 - cam.center[0] * cam.zoom}px, ${vh / 2 - cam.center[1] * cam.zoom}px) scale(${cam.zoom})`
    if (ghostRootRef.current) ghostRootRef.current.style.transform = root.style.transform
    domCameraRef.current = cam
  }, [])

  /** Ghost ink of the playing scene, at its world position (ghosts are top level). */
  const ghostInks = useCallback((): PaintInk[] => {
    const out: PaintInk[] = []
    for (const node of ghostNodesRef.current) if (isInk(node)) out.push({ node, offset: [node.x, node.y] })
    // Ink that exists only at this moment of a scene (changing ink objects).
    for (const node of playbackRef.current?.inks ?? []) if (isInk(node)) out.push({ node, offset: [node.x, node.y] })
    return out
  }, [])

  const applyPlaybackRef = useRef<() => void>(() => undefined)

  /** Put the playback overrides on content elements (and take them off the ones it no longer covers). */
  const applyPlaybackToDom = useCallback(() => {
    const frame = playbackRef.current
    const touched = new Set<HTMLElement>()
    if (frame) {
      const byId = indexRef.current.byId
      const ghosts = new Map(ghostNodesRef.current.map((node) => [node.id, node]))
      for (const [id, override] of frame.overrides) {
        const live = elementsRef.current.get(id)
        const element = live ?? ghostElementsRef.current.get(id)
        if (!element || !element.isConnected) continue
        const node = live ? byId.get(id) : ghosts.get(id)
        if (!node || isInk(node)) continue
        const box = live ? layoutRef.current.get(id) : null
        const origin: Point = box ? [box.x, box.y] : [(node as ContentNode).x, (node as ContentNode).y]
        const own = Number((node as ContentNode).style?.opacity ?? '1')
        applyElementOverride(element, override, origin, Number.isFinite(own) ? own : 1)
        touched.add(element)
      }
    }
    for (const element of playbackTouchedRef.current) if (!touched.has(element)) clearElementOverride(element)
    playbackTouchedRef.current = touched
  }, [])
  applyPlaybackRef.current = applyPlaybackToDom

  const requestPaint = useCallback(
    (layers: { committed?: boolean; active?: boolean }) => {
      if (layers.committed) dirtyLayersRef.current.committed = true
      if (layers.active) dirtyLayersRef.current.active = true
      if (paintFrameRef.current !== null) return
      paintFrameRef.current = requestAnimationFrame(() => {
        paintFrameRef.current = null
        const dirty = dirtyLayersRef.current
        dirtyLayersRef.current = { committed: false, active: false }
        if (dirty.committed) {
          applyContentTransform()
          paintItems(inkRef.current, paintInks(), viewportRef.current, cameraRef.current, new Set(selectedIdsRef.current), playbackRef.current, ghostInks())
        }
        if (dirty.active) paintActive(activeInkRef.current, activeRef.current, viewportRef.current, cameraRef.current)
      })
    },
    [applyContentTransform, ghostInks, paintInks]
  )
  // A cancelled frame must also clear its slot. React runs this cleanup and then
  // mounts again (StrictMode in dev, Fast Refresh): a slot left set says "a frame
  // is pending" forever, so the ink and the content layer never move again.
  useEffect(
    () => () => {
      cancelFrame(paintFrameRef)
      cancelFrame(measureFrameRef)
    },
    []
  )

  // ---------- Layout cache ----------

  /** Measure every content element into the layout cache, then add ink. */
  const measure = useCallback(() => {
    const root = contentRootRef.current
    // Playback transforms are only a look: measure the final layout without them.
    const playing = playbackTouchedRef.current.size > 0
    if (playing) for (const element of playbackTouchedRef.current) clearElementOverride(element)
    const layout: LayoutMap = root ? measureContent(root, elementsRef.current, domCameraRef.current.zoom) : new Map()
    if (playing) {
      playbackTouchedRef.current = new Set()
      applyPlaybackRef.current()
    }
    addInkLayout(indexRef.current, layout)
    layoutRef.current = layout
    setLayoutVersion((version) => version + 1)
    requestPaint({ committed: true })
  }, [requestPaint])

  /** Measure on the next frame (images, fonts and math settle late). */
  const requestMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null
      measure()
    })
  }, [measure])

  // The observer lives exactly as long as the mount: created here, observing every
  // element already registered, and gone after cleanup (a remount makes a new one).
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => requestMeasure())
    for (const element of elementsRef.current.values()) observer.observe(element)
    resizeObserverRef.current = observer
    return () => {
      observer.disconnect()
      if (resizeObserverRef.current === observer) resizeObserverRef.current = null
    }
  }, [requestMeasure])

  // Measure after every content render, before the browser paints.
  useLayoutEffect(() => {
    applyContentTransform()
    measure()
    // A re-rendered element lost nothing it needs, but a new one (a ghost) needs its override now.
    if (playbackRef.current) applyPlaybackToDom()
  }, [index, editingId, ghostIndex, applyContentTransform, measure, applyPlaybackToDom])

  useEffect(() => {
    void document.fonts?.ready.then(() => requestMeasure())
  }, [requestMeasure])

  /** Replace the live nodes (no history, no save). Renders the content layer. */
  const setNodes = useCallback(
    (next: BoardNode[]) => {
      nodesRef.current = next
      const nextIndex = buildIndex(next)
      indexRef.current = nextIndex
      // Ink layout now, so hit tests right after an edit are right; content is measured after render.
      const layout = new Map(layoutRef.current)
      for (const id of layout.keys()) if (!nextIndex.byId.has(id)) layout.delete(id)
      addInkLayout(nextIndex, layout)
      layoutRef.current = layout
      setIndex(nextIndex)
      requestPaint({ committed: true })
    },
    [requestPaint]
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
    const content = boundsOf(layoutRef.current.keys(), layoutRef.current)
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
      learnerViewAtRef.current = Date.now()
      const [vw, vh] = viewportRef.current
      const current = cameraRef.current
      const zoom = step === 'reset' ? 1 : step === 'out' ? current.zoom / 1.25 : current.zoom * 1.25
      applyCamera(zoomAt(current, [vw / 2, vh / 2], viewportRef.current, zoom))
    },
    [applyCamera]
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
      applyContentTransform()
      if (needsFitRef.current) {
        needsFitRef.current = false
        measure()
        fit()
      }
      requestPaint({ committed: true, active: true })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [applyContentTransform, fit, measure, requestPaint])

  // ---------- Nodes ----------

  const emit = useCallback(() => {
    onDocChangeRef.current({ nextSeq: nextSeqRef.current, nodes: nodesRef.current, extra: extraRef.current })
  }, [])

  /** Select nodes by id. Ids that are not on the board are dropped. */
  const setSelectedIds = useCallback(
    (ids: string[]) => {
      const byId = indexRef.current.byId
      const kept = [...new Set(ids)].filter((id) => byId.has(id))
      if (kept.length === 0 && selectedIdsRef.current.length === 0) return
      selectedIdsRef.current = kept
      setSelectedIdsState(kept)
      requestPaint({ committed: true })
    },
    [requestPaint]
  )

  /** Commit an edit: record undo, stamp seq on new or changed nodes, notify. */
  const commitNodes = useCallback(
    (next: BoardNode[], snapshot: BoardNode[] = nodesRef.current, by: Author = 'learner', record = true) => {
      if (next.length === snapshot.length && next.every((node, i) => node === snapshot[i])) {
        if (nodesRef.current !== snapshot) setNodes(snapshot)
        return
      }
      if (record) history.record(snapshot)
      const firstSeq = nextSeqRef.current
      const stamped = stampChanged(snapshot, next, nextSeqRef.current)
      nextSeqRef.current = stamped.nextSeq
      const now = Date.now()
      for (const node of stamped.nodes) {
        if (node.seq < firstSeq) continue
        editorsRef.current.set(node.id, by)
        timesRef.current.set(node.id, now)
      }
      const removed = stamped.removed.map((removal) => ({ ...removal, bounds: layoutRef.current.get(removal.node.id) ?? null, by }))
      setNodes(stamped.nodes)
      if (removed.length) onRemovedRef.current?.(removed)
      emit()
    },
    [emit, history, setNodes]
  )

  /** Undo or redo: the restored nodes count as changed, so they get a new seq. */
  const restore = useCallback(
    (snapshot: BoardNode[] | null) => {
      if (!snapshot) return
      const stamped = stampChanged(nodesRef.current, snapshot, nextSeqRef.current)
      nextSeqRef.current = stamped.nextSeq
      // Undo and redo are the learner's own actions (agents have no undo).
      const removed = stamped.removed.map((removal) => ({ ...removal, bounds: layoutRef.current.get(removal.node.id) ?? null, by: 'learner' as const }))
      setNodes(stamped.nodes)
      if (removed.length) onRemovedRef.current?.(removed)
      setSelectedIds([])
      emit()
    },
    [emit, setNodes, setSelectedIds]
  )
  const undo = useCallback(() => restore(history.undo(nodesRef.current)), [history, restore])
  const redo = useCallback(() => restore(history.redo(nodesRef.current)), [history, restore])

  /** Replace nodes by id with new versions, as one edit. */
  const replaceNodes = useCallback(
    (changes: Map<string, BoardNode>) => {
      if (!changes.size) return
      commitNodes(nodesRef.current.map((node) => changes.get(node.id) ?? node))
    },
    [commitNodes]
  )

  const eraseAt = useCallback(
    (screen: Point) => {
      const point = screenToBoard(screen, viewportRef.current, cameraRef.current)
      const radius = ERASE_RADIUS / cameraRef.current.zoom
      const layout = layoutRef.current
      const kept = nodesRef.current.filter((node) => {
        if (!isInk(node)) return true
        const box = layout.get(node.id)
        const offset: Point = box ? [box.ox, box.oy] : inkOffset(node, indexRef.current.byId, layout)
        return !strokeHitByCircle(node, offset, point, radius)
      })
      if (kept.length !== nodesRef.current.length) {
        setNodes(kept)
        if (dragRef.current) dragRef.current.changed = true
        if (selectedIdsRef.current.length) setSelectedIds([])
      }
    },
    [setNodes, setSelectedIds]
  )

  // ---------- Text editing ----------

  const startEditing = useCallback(
    (id: string, snapshot: BoardNode[] = nodesRef.current) => {
      const node = indexRef.current.byId.get(id)
      if (!node || node.kind !== 'text' || !isKnown(node)) return
      editingRef.current = { id, snapshot, initial: (node as TextNode).text }
      setSelectedIds([id])
      setEditingId(id)
    },
    [setSelectedIds]
  )

  /** Commit the open text editor: empty text deletes the node. One history step. */
  const commitEditing = useCallback(() => {
    const editing = editingRef.current
    if (!editing) return
    editingRef.current = null
    const value = editorRef.current?.value ?? editing.initial
    setEditingId(null)
    const node = indexRef.current.byId.get(editing.id)
    let next = nodesRef.current
    if (!node || node.kind !== 'text') {
      // The node is gone (undo, reload): nothing to save.
    } else if (!value.trim()) {
      next = nodesRef.current.filter((entry) => entry.id !== editing.id)
    } else if (value !== (node as TextNode).text) {
      next = nodesRef.current.map((entry) => (entry.id === editing.id ? ({ ...entry, text: value } as BoardNode) : entry))
    }
    commitNodes(next, editing.snapshot)
    setSelectedIds(value.trim() ? [editing.id] : [])
  }, [commitNodes, setSelectedIds])

  /** Create a text node at a board point and edit it. Not in history until it has text. */
  const createText = useCallback(
    (point: Point) => {
      const snapshot = nodesRef.current
      const node: TextNode = {
        id: newItemId('n'),
        kind: 'text',
        x: Math.round(point[0] * 10) / 10,
        y: Math.round((point[1] - NEW_TEXT_SIZE * 0.7) * 10) / 10,
        z: zAbove(indexRef.current.children.get(ROOT) ?? []),
        author: 'learner',
        seq: 0,
        text: '',
        style: { color, fontSize: `${NEW_TEXT_SIZE}px` }
      }
      setNodes([...snapshot, node])
      editingRef.current = { id: node.id, snapshot, initial: '' }
      setSelectedIds([node.id])
      setEditingId(node.id)
    },
    [color, setNodes, setSelectedIds]
  )

  const contentCtx = useRef<ContentContext>(null as unknown as ContentContext)
  contentCtx.current = {
    index,
    editingId,
    editorRef,
    editorInitial: editingRef.current?.initial ?? '',
    onEditorCommit: commitEditing,
    register: (id, element) => {
      const elements = elementsRef.current
      const previous = elements.get(id)
      if (element) {
        if (previous && previous !== element) resizeObserverRef.current?.unobserve(previous)
        elements.set(id, element)
        resizeObserverRef.current?.observe(element)
      } else if (previous) {
        resizeObserverRef.current?.unobserve(previous)
        elements.delete(id)
      }
    },
    onMedia: requestMeasure
  }

  const ghostCtx = useRef<ContentContext>(null as unknown as ContentContext)
  ghostCtx.current = {
    index: ghostIndex ?? buildIndex([]),
    editingId: null,
    editorRef,
    editorInitial: '',
    onEditorCommit: () => undefined,
    register: (id, element) => {
      if (element) ghostElementsRef.current.set(id, element)
      else ghostElementsRef.current.delete(id)
    },
    onMedia: () => undefined
  }

  // Leaving the select tool clears the selection; leaving the eraser hides its cursor.
  useEffect(() => {
    if (tool !== 'select' && tool !== 'text') setSelectedIds([])
    if (tool !== 'eraser' && eraserRef.current) eraserRef.current.style.opacity = '0'
  }, [tool, setSelectedIds])

  // ---------- Selection helpers ----------

  /** The scope for click selection: the parent of the current selection (ROOT when top level). */
  const selectionScope = (): string => {
    const byId = indexRef.current.byId
    const first = selectedIdsRef.current.map((id) => byId.get(id)).find((node) => node && !isInk(node))
    return first ? parentKey(first, byId) : ROOT
  }

  /** The ids a drag moves: flowed nodes move their top-level frame; no locked nodes. */
  const movableIds = (ids: readonly string[]): Set<string> => {
    const byId = indexRef.current.byId
    const mapped = ids.map((id) => {
      const node = byId.get(id)
      if (!node) return id
      return isFlowed(node, byId) ? topLevelOf(node, byId).id : id
    })
    return new Set(
      outermost(mapped, byId).filter((id) => {
        const node = byId.get(id)
        return node && isKnown(node) && !node.locked
      })
    )
  }

  const selectionBox = (ids: readonly string[]): Region | null => boundsOf(ids, layoutRef.current)

  const inSelectionBox = (screen: Point): boolean => {
    const box = selectionBox(selectedIdsRef.current)
    if (!box) return false
    const point = screenToBoard(screen, viewportRef.current, cameraRef.current)
    return regionContains(box, point, SELECTION_PAD / cameraRef.current.zoom)
  }

  /** The node a click at a board point hits: ink first (it is on top), then content. */
  const hitAt = (point: Point): BoardNode | null => {
    const index = indexRef.current
    const layout = layoutRef.current
    return inkAt(index, layout, point, TAP_SIZE / cameraRef.current.zoom) ?? contentAt(index, layout, point)
  }

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
    // The text editor handles its own pointer input.
    if (event.target instanceof HTMLTextAreaElement) return
    const penEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
    if (event.button === 2 && !penEraser) return
    const host = hostRef.current
    if (!host) return
    glideRef.current++
    if (dragRef.current) {
      // A second finger or pen during a drag is ignored; a stale drag of the same pointer is dropped.
      if (dragRef.current.pointerId !== event.pointerId) return
      cancelDrag()
    }
    // A press outside the editor commits it (blur); it also ends other text editing (a board rename).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== host) document.activeElement.blur()
    if (editingRef.current) commitEditing()
    const rect = host.getBoundingClientRect()
    const screen = cssPoint(event, rect)
    const startBoard = screenToBoard(screen, viewportRef.current, cameraRef.current)
    pasteAnchorRef.current = startBoard

    const shouldPan = !penEraser && (event.button === 1 || spaceRef.current || event.pointerType === 'touch')
    let kind: DragKind
    let moveIds: Set<string> | undefined
    let clicked: string | undefined
    let resize: DragState['resize']
    let additive = false

    if (shouldPan) kind = 'pan'
    else if (penEraser || tool === 'eraser') kind = 'erase'
    else if (tool === 'text') {
      const hit = contentAt(indexRef.current, layoutRef.current, startBoard)
      if (hit && hit.kind === 'text' && !hit.locked) startEditing(hit.id)
      else createText(startBoard)
      event.preventDefault()
      return
    } else if (tool === 'select') {
      const handle = event.target instanceof HTMLElement ? (event.target.dataset.handle as Handle | undefined) : undefined
      const selected = selectedIdsRef.current
      const box = selected.length === 1 ? layoutRef.current.get(selected[0]) : undefined
      if (handle && box) {
        kind = 'resize'
        resize = { id: selected[0], handle, box }
      } else {
        const hit = hitAt(startBoard)
        const target = hit ? selectTarget(hit, selectionScope(), indexRef.current.byId) : null
        if (target && event.shiftKey) {
          // Shift-click adds or removes; no drag.
          const ids = selected.includes(target.id) ? selected.filter((id) => id !== target.id) : [...selected, target.id]
          setSelectedIds(ids)
          kind = 'none'
        } else if (target) {
          if (!selected.includes(target.id)) setSelectedIds([target.id])
          else clicked = target.id
          kind = 'move'
          moveIds = movableIds(selectedIdsRef.current)
        } else if (!event.shiftKey && inSelectionBox(screen)) {
          kind = 'move'
          moveIds = movableIds(selected)
        } else {
          kind = 'lasso'
          additive = event.shiftKey
        }
      }
    } else kind = 'ink'

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
      startNodes: nodesRef.current,
      startCamera: cameraRef.current,
      startSelectedIds: [...selectedIdsRef.current],
      changed: false,
      lasso: [startBoard],
      moveIds,
      clicked,
      additive,
      resize
    }
    event.preventDefault()

    if (kind === 'pan') setPanning(true)
    else if (kind === 'ink') {
      const highlighter = tool === 'highlighter'
      activeRef.current = {
        id: newItemId(),
        kind: 'ink',
        x: 0,
        y: 0,
        z: 0,
        author: 'learner',
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

  /** Apply a resize drag to the start nodes. */
  const resizeTo = (drag: DragState, delta: Point, keepAspect: boolean): BoardNode[] => {
    const info = drag.resize
    if (!info) return drag.startNodes
    const startById = new Map(drag.startNodes.map((node) => [node.id, node]))
    const node = startById.get(info.id)
    if (!node || !isKnown(node)) return drag.startNodes
    const byId = indexRef.current.byId
    const aspect = keepAspect || (node.kind === 'image' && info.handle.length === 2)
    const next = resizedBox(info.box, info.handle, delta, aspect)
    const dx = next.x - info.box.x
    const dy = next.y - info.box.y
    let updated: BoardNode
    if (isInk(node)) {
      const sx = next.width / Math.max(1e-6, info.box.width)
      const sy = next.height / Math.max(1e-6, info.box.height)
      // World point → scaled about the box origin → back to local.
      const ox = info.box.ox
      const oy = info.box.oy
      const points = node.points.map(([x, y, p]) => {
        const wx = next.x + (ox + x - info.box.x) * sx
        const wy = next.y + (oy + y - info.box.y) * sy
        return [wx - ox, wy - oy, p] as InkNode['points'][number]
      })
      updated = { ...node, points }
    } else {
      const content = node as ContentNode
      const style: NodeStyle = { ...content.style, width: px(next.width) }
      if (content.kind === 'text') delete style.height
      else style.height = px(next.height)
      const flowed = isFlowed(content, byId)
      updated = { ...content, style, ...(flowed ? {} : { x: content.x + dx, y: content.y + dy }) } as BoardNode
    }
    return drag.startNodes.map((entry) => (entry.id === info.id ? updated : entry))
  }

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const screen = cssPoint(event, rect)
    const drag = dragRef.current
    const penEraserHover = event.pointerType === 'pen' && (event.buttons & 32) !== 0
    if ((tool === 'eraser' || penEraserHover || drag?.kind === 'erase') && event.pointerType !== 'touch') moveEraserCursor(screen)

    if (!drag && tool === 'select') host.dataset.overSelection = inSelectionBox(screen) ? 'true' : 'false'
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta: Point = [screen[0] - drag.last[0], screen[1] - drag.last[1]]
    drag.last = screen
    const zoom = cameraRef.current.zoom

    if (drag.kind === 'pan') {
      const current = cameraRef.current
      learnerViewAtRef.current = Date.now()
      applyCamera({ ...current, center: [current.center[0] - delta[0] / current.zoom, current.center[1] - delta[1] / current.zoom] })
    } else if (drag.kind === 'ink' && activeRef.current) {
      const stroke = activeRef.current
      const native = event.nativeEvent
      const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
      const minDistance = sampleScreenDistance / zoom
      for (const sample of samples.length ? samples : [native]) {
        const point = screenToBoard(cssPoint(sample, rect), viewportRef.current, cameraRef.current)
        const last = stroke.points[stroke.points.length - 1]
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < minDistance) continue
        stroke.points.push([point[0], point[1], pressureOf(event.pointerType, sample.pressure)])
      }
      requestPaint({ active: true })
    } else if (drag.kind === 'erase') {
      eraseAt(screen)
    } else if (drag.kind === 'move' && drag.moveIds) {
      const boardDelta: Point = [(screen[0] - drag.start[0]) / zoom, (screen[1] - drag.start[1]) / zoom]
      const moved = Math.hypot(screen[0] - drag.start[0], screen[1] - drag.start[1]) >= 2
      if (!drag.changed && !moved) return
      drag.changed = true
      setNodes(moveNodes(drag.startNodes, drag.moveIds, boardDelta))
    } else if (drag.kind === 'resize') {
      const boardDelta: Point = [(screen[0] - drag.start[0]) / zoom, (screen[1] - drag.start[1]) / zoom]
      drag.changed = true
      setNodes(resizeTo(drag, boardDelta, event.shiftKey))
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

  /** Commit a finished learner stroke; it joins the top-most top-level frame that holds most of it. */
  const commitStroke = (stroke: InkNode): void => {
    const index = indexRef.current
    const layout = layoutRef.current
    const bounds = inkBounds(stroke, [0, 0])
    let node = normalizeInk(stroke)
    const frames = (index.children.get(ROOT) ?? []).filter(isFrame).filter((frame) => frame.style.display !== 'none')
    const host = bounds ? [...frames].reverse().find((frame) => {
      const box = layout.get(frame.id)
      return box ? overlapShare(bounds, box) >= PARENT_SHARE : false
    }) : undefined
    const hostBox = host ? layout.get(host.id) : undefined
    if (host && hostBox) {
      node = { ...node, parent: host.id, x: node.x - hostBox.ox, y: node.y - hostBox.oy, z: zAbove(index.children.get(host.id) ?? []) }
    } else {
      node = { ...node, z: zAbove(index.children.get(ROOT) ?? []) }
    }
    lastStrokeAtRef.current = Date.now()
    commitNodes([...nodesRef.current, node])
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
      // A fresh object: the one drawn into was mutated while drawing.
      commitStroke({ ...stroke, points: [...stroke.points] })
      requestPaint({ active: true })
    } else if (drag.kind === 'pan') {
      setPanning(false)
    } else if ((drag.kind === 'erase' || drag.kind === 'move' || drag.kind === 'resize') && drag.changed) {
      const ids = selectedIdsRef.current
      commitNodes(nodesRef.current, drag.startNodes)
      if (drag.kind !== 'erase') setSelectedIds(ids)
    } else if (drag.kind === 'move' && !drag.changed && drag.clicked && selectedIdsRef.current.length > 1) {
      // A click (no drag) on a node of a multi-selection selects it alone.
      setSelectedIds([drag.clicked])
    } else if (drag.kind === 'lasso') {
      drag.points.push(screen)
      drag.lasso.push(screenToBoard(screen, viewportRef.current, cameraRef.current))
      const xs = drag.points.map((point) => point[0])
      const ys = drag.points.map((point) => point[1])
      const isTap = Math.max(...xs) - Math.min(...xs) < TAP_SIZE && Math.max(...ys) - Math.min(...ys) < TAP_SIZE
      if (isTap) {
        // A tap on empty canvas clears the selection (a tap on a node selected it on press).
        if (!drag.additive) setSelectedIds([])
      } else {
        const polygon = drag.lasso
        const index = indexRef.current
        const layout = layoutRef.current
        const picked: string[] = []
        // Top-level content by box, ink anywhere by length; ink inside a picked frame moves with it.
        for (const node of index.children.get(ROOT) ?? []) {
          if (!isContent(node)) continue
          const box = layout.get(node.id)
          if (box && regionInsidePolygon(box, polygon)) picked.push(node.id)
        }
        for (const node of inkPaintOrder(index)) {
          const box = layout.get(node.id)
          const offset: Point = box ? [box.ox, box.oy] : inkOffset(node, index.byId, layout)
          if (strokeInsidePolygon(node, offset, polygon)) picked.push(node.id)
        }
        const ids = outermost(picked, index.byId)
        setSelectedIds(drag.additive ? [...drag.startSelectedIds, ...ids] : ids)
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
    if (drag.kind === 'move' || drag.kind === 'erase' || drag.kind === 'resize') setNodes(drag.startNodes)
    if (drag.kind === 'move' || drag.kind === 'lasso' || drag.kind === 'resize') setSelectedIds(drag.startSelectedIds)
    if (drag.kind === 'pan') {
      applyCamera(drag.startCamera)
      setPanning(false)
    }
    setLassoPoints(null)
    requestPaint({ active: true })
  }

  /** Double-click: drill into a frame (Figma style); on text, edit it. */
  const doubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (tool !== 'select' || event.target instanceof HTMLTextAreaElement) return
    const host = hostRef.current
    if (!host) return
    const point = screenToBoard(cssPoint(event, host.getBoundingClientRect()), viewportRef.current, cameraRef.current)
    const index = indexRef.current
    if (inkAt(index, layoutRef.current, point, TAP_SIZE / cameraRef.current.zoom)) return
    const hit = contentAt(index, layoutRef.current, point)
    if (!hit) return
    const selected = selectedIdsRef.current.length === 1 ? index.byId.get(selectedIdsRef.current[0]) : undefined
    let target: BoardNode
    if (selected && selected.id === hit.id) target = hit
    else if (selected && isFrame(selected)) target = selectTarget(hit, selected.id, index.byId)
    else target = selectTarget(hit, selectionScope(), index.byId)
    if (target.kind === 'text' && target.id === hit.id && isKnown(target) && !target.locked) startEditing(target.id)
    else setSelectedIds([target.id])
  }

  // ---------- Wheel: trackpad pan, pinch zoom, ⌘ + scroll zoom ----------

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wheel = (event: WheelEvent): void => {
      // An open text editor that can scroll this way scrolls; everything else on the board pans or zooms.
      if (!event.ctrlKey && !event.metaKey && canScroll(event.target, event.deltaX, event.deltaY)) return
      event.preventDefault()
      glideRef.current++
      learnerViewAtRef.current = Date.now()
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
    // Capture phase on the board root: every layer under the pointer (ink, content, selection) pans alike.
    host.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => host.removeEventListener('wheel', wheel, { capture: true })
  }, [applyCamera])

  // ---------- Restyle (palette) ----------

  const applyColor = useCallback(
    (value: string): boolean => {
      const byId = indexRef.current.byId
      const changes = new Map<string, BoardNode>()
      for (const id of selectedIdsRef.current) {
        const node = byId.get(id)
        if (!node || !isKnown(node) || node.locked) continue
        if (node.kind === 'ink' && node.color !== value) changes.set(id, { ...node, color: value })
        else if (node.kind === 'text' && node.style.color !== value) changes.set(id, { ...node, style: { ...node.style, color: value } })
        else if (node.kind === 'frame' && node.style.backgroundColor !== value) {
          const style: NodeStyle = { ...node.style, backgroundColor: value }
          delete style.background
          changes.set(id, { ...node, style })
        }
      }
      replaceNodes(changes)
      return selectedIdsRef.current.length > 0
    },
    [replaceNodes]
  )

  const applyWidth = useCallback(
    (value: number): boolean => {
      const byId = indexRef.current.byId
      const changes = new Map<string, BoardNode>()
      for (const id of selectedIdsRef.current) {
        const node = byId.get(id)
        if (!node || !isInk(node) || node.locked) continue
        const next = value * (node.tool === 'highlighter' ? HIGHLIGHTER_SCALE : 1)
        if (node.width !== next) changes.set(id, { ...node, width: next })
      }
      replaceNodes(changes)
      return changes.size > 0
    },
    [replaceNodes]
  )

  // ---------- Handle ----------

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
        nodes: nodesRef.current,
        nextSeq: nextSeqRef.current,
        camera: cameraRef.current,
        viewport: viewportRef.current,
        selectedIds: selectedIdsRef.current,
        bounds: (id) => {
          const box = layoutRef.current.get(id)
          return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null
        },
        inks: paintInks,
        layout: () => layoutRef.current,
        editor: (id) => editorsRef.current.get(id),
        changedAt: (id) => timesRef.current.get(id),
        learnerInkAt: lastStrokeAtRef.current,
        drawing: dragRef.current?.kind === 'ink',
        learnerViewAt: learnerViewAtRef.current,
        inkColor: colorRef.current
      }),
      animateTo: (target, ms = 420) => {
        const token = ++glideRef.current
        const from = cameraRef.current
        const start = performance.now()
        // Zoom moves in log space, so the glide feels even at every scale.
        const step = (): void => {
          if (glideRef.current !== token) return
          const t = Math.min(1, (performance.now() - start) / Math.max(1, ms))
          const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
          applyCamera({
            center: [from.center[0] + (target.center[0] - from.center[0]) * e, from.center[1] + (target.center[1] - from.center[1]) * e],
            zoom: Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * e)
          })
          if (t < 1) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      },
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
      },
      applyColor,
      applyWidth,
      agentCommit: (next) => {
        // An agent edit ends a learner's text editing first, so the two never mix.
        if (editingRef.current) commitEditing()
        flushSync(() => commitNodes(next, nodesRef.current, 'agent'))
        measure()
        const present = new Set(next.map((node) => node.id))
        if (selectedIdsRef.current.some((id) => !present.has(id))) setSelectedIds(selectedIdsRef.current.filter((id) => present.has(id)))
      },
      agentAmend: (next) => {
        if (editingRef.current) commitEditing()
        flushSync(() => commitNodes(next, nodesRef.current, 'agent', false))
        measure()
      },
      remeasure: measure,
      setPresence,
      selectAll: () => selectAllRef.current(),
      setPlayback: (frame) => {
        const ghosts = frame?.ghosts ?? []
        if (ghosts !== ghostNodesRef.current) {
          ghostNodesRef.current = ghosts
          const content = ghosts.filter((node) => !isInk(node))
          // The ghost layer renders before this returns, so its elements get their overrides now.
          flushSync(() => setGhostIndex(content.length ? buildIndex(content) : null))
        }
        playbackRef.current = frame
        applyPlaybackToDom()
        requestPaint({ committed: true })
        // The end of playback: measure the final layout once more.
        if (!frame) requestMeasure()
      }
    }),
    [applyCamera, applyColor, applyPlaybackToDom, applyWidth, commitEditing, commitNodes, fit, measure, paintInks, requestMeasure, requestPaint, setSelectedIds, zoomStep]
  )
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
      glideRef.current++ // stop a running camera glide
    },
    []
  )

  // ---------- Keyboard ----------

  const selectAll = useCallback(() => {
    if (editingRef.current) return
    setSelectedIds((indexRef.current.children.get(ROOT) ?? []).map((node) => node.id))
  }, [setSelectedIds])

  const applyAction = (action: BoardKeyAction): void => {
    const ids = [...selectedIdsRef.current]
    const index = indexRef.current
    const layout = layoutRef.current
    if (action === 'selectAll') selectAll()
    else if (action === 'undo') undo()
    else if (action === 'redo') redo()
    else if (action === 'copy' || action === 'cut') {
      const copied = copySubtrees(ids, index, layout, { detach: true })
      if (copied.roots.length) writeNodeClipboard(copied)
      if (action === 'cut' && copied.roots.length) {
        commitNodes(removeNodes(nodesRef.current, ids, index))
        setSelectedIds([])
      }
    } else if (action === 'delete') {
      commitNodes(removeNodes(nodesRef.current, ids, index))
      setSelectedIds([])
    } else if (action === 'duplicate') {
      const copied = copySubtrees(ids, index, layout, { detach: false })
      const roots = new Set(copied.roots)
      // Each copy goes on top of its siblings; free copies shift a little.
      const zNext = new Map<string, number>()
      const nodes = copied.nodes.map((node) => {
        if (!roots.has(node.id) || !isKnown(node)) return node
        const key = parentKey(node, index.byId)
        const z = zNext.get(key) ?? zAbove(index.children.get(key) ?? [])
        zNext.set(key, z + 1)
        const flowed = isFlowed(node, index.byId)
        return { ...node, z, ...(flowed ? {} : { x: node.x + DUPLICATE_OFFSET, y: node.y + DUPLICATE_OFFSET }) } as BoardNode
      })
      if (copied.roots.length) {
        commitNodes([...nodesRef.current, ...nodes])
        setSelectedIds(copied.roots)
      }
    } else if (action === 'paste') {
      const clip = readNodeClipboard()
      if (!clip.roots.length) return
      // Fresh ids again, so a second paste does not collide.
      const idMap = new Map(clip.nodes.map((node) => [node.id, newItemId(node.kind === 'ink' ? 's' : 'n')]))
      const roots = new Set(clip.roots)
      const rootNodes = clip.nodes.filter((node) => roots.has(node.id) && isKnown(node)) as (BoardNode & { x: number; y: number })[]
      const anchor = pasteAnchorRef.current ?? cameraRef.current.center
      // The roots' world top-left: ink points may sit far from the node's x, y (v1 ink has x = y = 0).
      const left = (node: BoardNode & { x: number; y: number }): Point => {
        const local = isInk(node) ? inkLocalBounds(node) : null
        return [node.x + (local?.x ?? 0), node.y + (local?.y ?? 0)]
      }
      const minX = Math.min(...rootNodes.map((node) => left(node)[0]))
      const minY = Math.min(...rootNodes.map((node) => left(node)[1]))
      let z = zAbove(index.children.get(ROOT) ?? [])
      const nodes = clip.nodes.map((node) => {
        const copy = { ...node, id: idMap.get(node.id) as string } as BoardNode & { parent?: string }
        if (typeof node.parent === 'string' && idMap.has(node.parent)) copy.parent = idMap.get(node.parent)
        if (roots.has(node.id) && isKnown(node)) {
          return { ...copy, x: node.x - minX + anchor[0], y: node.y - minY + anchor[1], z: z++ } as BoardNode
        }
        return copy as BoardNode
      })
      commitNodes([...nodesRef.current, ...nodes])
      setSelectedIds(clip.roots.map((id) => idMap.get(id) as string))
      pasteAnchorRef.current = null
    }
  }

  const nudge = (dx: number, dy: number): void => {
    const ids = movableIds(selectedIdsRef.current)
    if (!ids.size) return
    const selection = [...selectedIdsRef.current]
    commitNodes(moveNodes(nodesRef.current, ids, [dx, dy]))
    setSelectedIds(selection)
  }

  const selectAllRef = useRef(selectAll)
  selectAllRef.current = selectAll

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (dragRef.current) cancelDrag()
      else if (selectedIdsRef.current.length) {
        // Go up one level, or clear at the top.
        const byId = indexRef.current.byId
        const first = byId.get(selectedIdsRef.current[0])
        const key = first ? parentKey(first, byId) : ROOT
        setSelectedIds(key === ROOT ? [] : [key])
      } else return
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
    const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (!modified && !event.altKey && arrows[event.key] && selectedIdsRef.current.length) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      nudge(arrows[event.key][0] * step, arrows[event.key][1] * step)
      return
    }
    const action = boardKeyAction(event, { hasSelection: selectedIdsRef.current.length > 0, hasClipboard: hasNodeClipboard() })
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

  void layoutVersion // the selection box reads the layout cache, which this version tracks
  const selection = editingId ? null : selectionBox(selectedIds)
  const selectionTopLeft = selection ? boardToScreen([selection.x, selection.y], viewport, camera) : null
  const single = selectedIds.length === 1 ? index.byId.get(selectedIds[0]) : undefined
  const handles = selection && single && tool === 'select' ? handlesFor(single) : []
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
      onDoubleClick={doubleClick}
      onPointerLeave={() => {
        if (!dragRef.current) moveEraserCursor(null)
      }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label="Board canvas"
    >
      <ContentLayer index={index} editingId={editingId} ctx={contentCtx} rootRef={contentRootRef} />
      {ghostIndex && <ContentLayer index={ghostIndex} editingId={null} ctx={ghostCtx} rootRef={ghostRootRef} />}
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
          data-single={single ? 'true' : undefined}
          style={{
            left: selectionTopLeft[0] - SELECTION_PAD,
            top: selectionTopLeft[1] - SELECTION_PAD,
            width: selection.width * camera.zoom + SELECTION_PAD * 2,
            height: selection.height * camera.zoom + SELECTION_PAD * 2
          }}
        >
          {handles.map((handle) => (
            <span key={handle} className="board__handle" data-handle={handle} />
          ))}
        </div>
      )}
      {presence.map((entry) => {
        const box = layoutRef.current.get(entry.id)
        if (!box) return null
        const topLeft = boardToScreen([box.x, box.y], viewport, camera)
        return (
          <div
            key={entry.id}
            className="board__presence"
            style={{ left: topLeft[0] - 4, top: topLeft[1] - 4, width: box.width * camera.zoom + 8, height: box.height * camera.zoom + 8 }}
            aria-hidden="true"
          >
            <span className="board__presence-label">{entry.label}</span>
          </div>
        )
      })}
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
