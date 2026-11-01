import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { isContent, isFrame, isInk, isInkHost, isKnown, isLive, newItemId, nodeOpacity, stampChanged, type Author, type BoardDoc, type LiveNode, type NodeStyle, type Removal, type Revision } from '@shared/board-format'
import { isEditableTarget } from '../lib/keys'
import type { ToolId } from '../tools'
import { boardKeyAction, hasNodeClipboard, readNodeClipboard, writeNodeClipboard, type BoardKeyAction } from './clipboard'
import { ContentLayer, measureContent, type ContentContext } from './content'
import {
  boardToScreen,
  clampZoom,
  glideCamera,
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
import { ActiveInk, InkLayers, type PaintInk } from './paint'
import { enteredWorld, enterLive, enteredLive, enterWorlds, markWorlds, moveWorlds, nearWorlds, pickWorlds, pressWorlds, sendWorldInk, sendWorldPointer, setLivePlayback, wantsPointerMoves } from '../live-pixels/registry'
import { bindWorldBoard, hasWorlds, syncWorlds } from '../live-pixels/world/surface'
import type { WorldPointer } from '@shared/world-protocol'
import { copiedLinks, linkedBox, linkedTip, linkLook, pointNow, withLink, type LinkedNode, type LinkLook, type WorldPoints } from '@shared/world-links'
import { applyElementOverride, clearElementOverride, type NodeOverride, type PlaybackFrame } from './playback'
import {
  addInkLayout,
  applyChanges,
  boundsOf,
  buildIndex,
  contentAt,
  copySubtrees,
  withoutScene,
  inkAt,
  inkOffset,
  inkPaintOrder,
  isFlowed,
  shownNow,
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
  type SceneIndex,
  type Shown
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
  /** Glide the camera to `camera` over `ms`. With `follow`, the camera goes to the place it gives, and stays on it until it gives null. Any learner pan, zoom or pointer input stops the glide. While `held` says true, the glide stands, and it goes on from there. */
  animateTo(camera: Camera, ms?: number, held?: () => boolean, follow?: () => Point | null): void
  /** The place of a point of a world in the last picture shown, or null. */
  worldPoint(world: string, point: string): Point | null
  /** The points of the last picture shown. */
  worldPoints(): WorldPoints
  /** A mark at this item's centre stays on the part of a world under it, if there is one. */
  pinMark(id: string, by: Author): void
  /** Restyle the selection with a palette colour. Returns false when nothing is selected. */
  applyColor(color: string): boolean
  /** Restyle selected ink with a palette width. Returns false when no ink is selected. */
  applyWidth(width: number): boolean
  /**
   * Commit an agent edit as one undo step, then lay it out before returning,
   * so the layout cache has the new nodes' bounds. The edit is the change from
   * `base` (the nodes it was computed from) to `next`, and it applies to the
   * current document by item id (scene.ts applyChanges), after an open text
   * editor commits and under a drag, so the learner's edits stay. With `step`,
   * every commit with the same key that follows it directly (no other edit,
   * undo or redo between them) joins that one undo step: an action made of
   * several commits (play_scene start of a scene that is on the board, cut,
   * clear_queue) is one step for the learner.
   */
  agentCommit(base: readonly BoardNode[], next: BoardNode[], options?: { step?: string }): void
  /**
   * Change the last agent commit without a new undo step (a post-layout
   * correction of the same write), then lay it out before returning. Applied as agentCommit is.
   */
  agentAmend(base: readonly BoardNode[], next: BoardNode[]): void
  /** The board's id (BoardDoc.id), or undefined when it has none yet. */
  boardId(): string | undefined
  /** Give the board its id (the first scene record, main/scene-store.ts): it is saved with the board. */
  setBoardId(id: string): void
  /** Measure the content layer now (after images load). */
  remeasure(): void
  /** Select every top-level node and all loose ink (⌘A on the canvas). */
  selectAll(): void
  /** Commit what the learner has open, the text editor and a stroke in progress: the board is about to save, close or leave. */
  settle(): void
  /**
   * Show a moment of live-scene playback (see playback.ts), or end it with
   * null. Content elements change before this returns, so a scene committed
   * in the same task never shows its final state first.
   */
  setPlayback(frame: PlaybackFrame | null): void
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
  inks(): readonly PaintInk[]
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
  /**
   * A commit stamped nodes: the ones that left the board (erase, cut, delete,
   * undo; each removal has its own seq) and the ones that took a new seq, with
   * their state before (revisions). `by` made the change.
   */
  onChanges?(change: { removed: Removal[]; revisions: Revision[]; by: Author }): void
  /** The selection changed (node ids): the scene pill shows the scene and step of a selected item. */
  onSelectionChange?(ids: readonly string[]): void
  ref?: Ref<BoardHandle>
}

/** Highlighter strokes are this many times wider than pen strokes. */
export const HIGHLIGHTER_SCALE = 4
/** Stroke eraser radius in screen pixels. */
const ERASE_RADIUS = 10
/** Grid pitch in board points. */
const GRID_PITCH = 24
/** A press waits this long for a world's answer: long enough for a pick, too short to feel. */
const PICK_HOLD_MS = 30
/** A mark waits this long for a world's answer: nothing waits on it. */
const PICK_MARK_MS = 300
/** A linked item fades out over this long when its point is hidden. */
const LINK_FADE_MS = 200
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
  /** The document under the drag: the last commit. A commit during the drag replaces it (commitOver). */
  startNodes: BoardNode[]
  startCamera: Camera
  startSelectedIds: string[]
  changed: boolean
  /** Lasso only: every pointer sample, in board coordinates. */
  lasso: Point[]
  /** Move: the ids that move. */
  moveIds?: Set<string>
  /** Move and resize: how far the pointer is from the start, in board points. */
  delta?: Point
  /** Resize: Shift keeps the aspect ratio. */
  keepAspect?: boolean
  /** Erase: the ids erased so far. */
  erased?: Set<string>
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

const NO_INDEX = buildIndex([])

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

/** A pin goes with its mark: an erased or undone mark leaves no pin. */
function withoutLostPins(nodes: BoardNode[]): BoardNode[] {
  if (!nodes.some((node) => isLive(node) && node.pins?.length)) return nodes
  const ids = new Set(nodes.map((node) => node.id))
  return nodes.map((node) => (isLive(node) && node.pins?.some((pin) => !ids.has(pin.id)) ? { ...node, pins: node.pins.filter((pin) => ids.has(pin.id)) } : node))
}

export function Board({ doc, history, initialCamera, tool, color, width, onDocChange, onCameraChange, onChanges, onSelectionChange, ref }: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const penRef = useRef<HTMLDivElement>(null)
  const activeInkRef = useRef<HTMLCanvasElement>(null)
  const activeTailRef = useRef<HTMLCanvasElement>(null)
  const eraserRef = useRef<HTMLDivElement>(null)
  const contentRootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const nodesRef = useRef<BoardNode[]>(doc.nodes)
  const indexRef = useRef<SceneIndex>(null as unknown as SceneIndex)
  indexRef.current ??= buildIndex(doc.nodes)
  const layoutRef = useRef<LayoutMap>(new Map())
  /** The layout as measured: linked items at their resting place. `layoutRef` shows them where they are now. */
  const restLayoutRef = useRef<LayoutMap>(layoutRef.current)
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const nextSeqRef = useRef(doc.nextSeq)
  /** The step key of the last undo step when an agent commit with a key made it (agentCommit), else null. */
  const stepKeyRef = useRef<string | null>(null)
  const extraRef = useRef(doc.extra)
  const idRef = useRef(doc.id)
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
  const liveInkRef = useRef<HTMLCanvasElement>(null)
  const inkLayersRef = useRef<InkLayers>(null as unknown as InkLayers)
  inkLayersRef.current ??= new InkLayers()
  const activeLayerRef = useRef<ActiveInk>(null as unknown as ActiveInk)
  activeLayerRef.current ??= new ActiveInk()
  const paintFrameRef = useRef<number | null>(null)
  const dirtyLayersRef = useRef({ committed: false, active: false, playback: false })
  const editingRef = useRef<EditingState | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  /** Counts the measures, so that a commit that a layout effect measured does not measure again. */
  const measuresRef = useRef(0)
  /** What the last render's measure saw: only a change here moves a box. */
  const measuredRef = useRef<{ content: readonly BoardNode[]; editingId: string | null; ghostIndex: SceneIndex | null } | null>(null)
  /** Live-scene playback: the frame shown now, the ghost layer, and the elements it changed. */
  const playbackRef = useRef<PlaybackFrame | null>(null)
  /** What the learner sees now: every learner input that picks or changes items asks it (scene.ts shownNow). */
  const shown = useCallback<Shown>((node) => shownNow(node, indexRef.current.byId, playbackRef.current?.overrides ?? null) && linksRef.current.get(node.id)?.alpha !== 0, [])
  const ghostRootRef = useRef<HTMLDivElement>(null)
  const ghostElementsRef = useRef(new Map<string, HTMLElement>())
  const ghostNodesRef = useRef<readonly BoardNode[]>([])
  const ghostByIdRef = useRef<ReadonlyMap<string, BoardNode>>(new Map())
  /** The element of each node that shows an override now. */
  const appliedRef = useRef(new Map<string, HTMLElement>())
  /** The overrides with world params (for the registry), and what it got last. */
  const liveParamsRef = useRef(new Map<string, NodeOverride>())
  const liveSentRef = useRef<{ dirty: boolean; clocks: PlaybackFrame['clocks'] | null; on: boolean }>({ dirty: false, clocks: null, on: false })
  /** The items that follow a point of a world: how each shows now, and its fade when its point is hidden or shown again. */
  const linksRef = useRef(new Map<string, { look: LinkLook; alpha: number }>())
  const linkedNodesRef = useRef<{ index: SceneIndex | null; ghosts: readonly BoardNode[] | null; list: LinkedNode[] }>({ index: null, ghosts: null, list: [] })
  const worldPointsRef = useRef<WorldPoints>({})
  const fadeAtRef = useRef(0)
  /** What worlds moved themselves by: only selection and links read it. */
  const anchorsRef = useRef(new Map<string, Point>())
  /** A press waits here for the worlds' answer, with what came after it. */
  const holdRef = useRef<{ pointerId: number; events: Array<['move' | 'up' | 'cancel', React.PointerEvent<HTMLDivElement>]> } | null>(null)
  /** The press that goes to a world. */
  const streamRef = useRef<{ id: string; pointerId: number } | null>(null)
  /** The pointer's last move, for the worlds that listen: it goes once per paint. */
  const moveRef = useRef<WorldPointer | null>(null)
  /** Pen tips and changing ink in the last frame (the ink canvas paints again when they go). */
  const inkMomentRef = useRef({ tips: 0, inks: 0 })
  const [ghostIndex, setGhostIndex] = useState<SceneIndex | null>(null)

  const [camera, setCamera] = useState<Camera>(cameraRef.current)
  /** cameraRef moved since `camera` last took it. */
  const cameraStaleRef = useRef(false)
  const [viewport, setViewport] = useState<Point>([1, 1])
  const [index, setIndex] = useState<SceneIndex>(indexRef.current)
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [selectedIds, setSelectedIdsState] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lassoPoints, setLassoPoints] = useState<Point[] | null>(null)
  const [panReady, setPanReady] = useState(false)
  const [panning, setPanning] = useState(false)
  const [flashRect, setFlashRect] = useState<{ rect: Region; id: number } | null>(null)
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
  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  useEffect(() => {
    onSelectionChangeRef.current?.(selectedIds)
  }, [selectedIds])
  useEffect(() => () => onSelectionChangeRef.current?.([]), [])

  // ---------- Painting (batched to one frame) ----------

  /** Every ink node with its world offset, in paint order: the same array while the nodes and the layout are the same. */
  const paintInksRef = useRef<{ index: SceneIndex | null; layout: LayoutMap | null; list: readonly PaintInk[] }>({ index: null, layout: null, list: [] })
  const paintInks = useCallback((): readonly PaintInk[] => {
    const memo = paintInksRef.current
    const layout = restLayoutRef.current
    const index = indexRef.current
    if (memo.index !== index || memo.layout !== layout) {
      const list: PaintInk[] = inkPaintOrder(index).map((node) => {
        const box = layout.get(node.id)
        return { node, offset: box ? [box.ox, box.oy] : inkOffset(node, index.byId, layout) }
      })
      paintInksRef.current = { index, layout, list }
      return list
    }
    return memo.list
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

  /** Ghost ink of the playing scenes, at its world position (ghosts are top level): the same array while the ghosts are the same. */
  const ghostInksRef = useRef<{ ghosts: readonly BoardNode[] | null; list: readonly PaintInk[] }>({ ghosts: null, list: [] })
  const ghostInks = useCallback((): readonly PaintInk[] => {
    const ghosts = ghostNodesRef.current
    if (ghostInksRef.current.ghosts !== ghosts) {
      const list: PaintInk[] = []
      for (const node of ghosts) if (isInk(node)) list.push({ node, offset: [node.x, node.y] })
      ghostInksRef.current = { ghosts, list }
    }
    return ghostInksRef.current.list
  }, [])

  const applyPlaybackRef = useRef<() => void>(() => undefined)

  /**
   * Put the playback overrides on content elements, and take them off the
   * ones they no longer cover: for the nodes in `changed`, or for every node
   * (null). An element writes only the values that differ from the override
   * it shows (applyElementOverride).
   */
  const applyPlaybackToDom = useCallback((changed: ReadonlySet<string> | null = null) => {
    const frame = playbackRef.current
    const applied = appliedRef.current
    const live = liveParamsRef.current
    const sent = liveSentRef.current
    const show = (id: string): void => {
      const own = frame?.overrides.get(id)
      const link = linksRef.current.get(id)
      const override = link ? withLink(own, link.look, link.alpha) : own
      if (override?.params) {
        if (live.get(id) !== override) {
          live.set(id, override)
          sent.dirty = true
        }
      } else if (live.delete(id)) sent.dirty = true
      const before = applied.get(id)
      const mine = elementsRef.current.get(id)
      const element = mine ?? ghostElementsRef.current.get(id)
      const node = override && element?.isConnected ? (mine ? indexRef.current.byId.get(id) : ghostByIdRef.current.get(id)) : undefined
      if (before && before !== element) clearElementOverride(before)
      if (!override || !element || !node || isInk(node)) {
        if (before === element && before) clearElementOverride(before)
        applied.delete(id)
        return
      }
      const box = mine ? restLayoutRef.current.get(id) : null
      const origin: Point = box ? [box.x, box.y] : [(node as ContentNode).x, (node as ContentNode).y]
      applyElementOverride(element, override, origin, nodeOpacity(node as ContentNode))
      applied.set(id, element)
    }
    if (changed) for (const id of changed) show(id)
    else {
      for (const id of [...applied.keys()]) if (!frame?.overrides.has(id)) show(id)
      for (const id of [...live.keys()]) if (!frame?.overrides.has(id)) show(id)
      if (frame) for (const id of frame.overrides.keys()) show(id)
      for (const id of linksRef.current.keys()) if (!frame?.overrides.has(id)) show(id)
    }
    // Worlds: their params and scene clocks, when they changed.
    if (!frame) {
      if (sent.on) setLivePlayback(null)
      liveSentRef.current = { dirty: false, clocks: null, on: false }
    } else if (sent.dirty || frame.clocks !== sent.clocks) {
      setLivePlayback({ overrides: live, clocks: frame.clocks })
      liveSentRef.current = { dirty: false, clocks: frame.clocks, on: true }
    }
  }, [])
  applyPlaybackRef.current = applyPlaybackToDom

  /** The nodes with a link now: the same list while the nodes are the same. */
  const linkedNodes = useCallback(() => {
    const memo = linkedNodesRef.current
    if (memo.index !== indexRef.current || memo.ghosts !== ghostNodesRef.current) {
      const nodes = [...indexRef.current.byId.values(), ...ghostNodesRef.current]
      const list = nodes.filter((node) => isKnown(node) && !!node.follows) as unknown as LinkedNode[]
      linkedNodesRef.current = { index: indexRef.current, ghosts: ghostNodesRef.current, list }
      return list
    }
    return memo.list
  }, [])

  /** Show these links now: on content elements here, on the ink in the paint that is under way. */
  const showLinks = useCallback(
    (changed: ReadonlySet<string>) => {
      if (!changed.size) return
      applyPlaybackToDom(changed)
      inkLayersRef.current.note(changed)
      dirtyLayersRef.current.playback = true
    },
    [applyPlaybackToDom]
  )

  /** Hit tests, selection boxes and agent bounds read linked items where they show now. */
  const placeLinks = useCallback(() => {
    const rest = restLayoutRef.current
    const links = linksRef.current
    const anchors = anchorsRef.current
    if (!links.size && !anchors.size) {
      layoutRef.current = rest
      return
    }
    const live = new Map(rest)
    for (const [id, link] of links) {
      const box = rest.get(id)
      if (box) live.set(id, linkedBox(box, link.look))
    }
    for (const [id, [dx, dy]] of anchors) {
      const box = rest.get(id)
      if (box) live.set(id, { ...box, x: box.x + dx, y: box.y + dy })
    }
    layoutRef.current = live
  }, [])

  /**
   * The points of the picture this paint adopts: linked items move to them.
   * An item whose world has no point now stays at its last place.
   */
  const followPoints = useCallback(
    (points: WorldPoints) => {
      // A world that gives no points in this picture keeps its last ones.
      worldPointsRef.current = { ...worldPointsRef.current, ...points }
      const links = linksRef.current
      const changed = new Set<string>()
      const nodes = linkedNodes()
      for (const node of nodes) {
        const look = linkLook(node, points)
        if (!look) continue
        const was = links.get(node.id)
        if (was && JSON.stringify(was.look) === JSON.stringify(look)) continue
        links.set(node.id, { look, alpha: was?.alpha ?? (look.visible ? 1 : 0) })
        changed.add(node.id)
      }
      showLinks(changed)
      if (changed.size) {
        placeLinks()
        if (selectedIdsRef.current.some((id) => changed.has(id))) setLayoutVersion((version) => version + 1)
      }
    },
    [linkedNodes, placeLinks, showLinks]
  )

  /** One step of the fades of links: true while one goes on. */
  const fadeLinks = useCallback((): boolean => {
    const now = performance.now()
    const step = Math.min(0.25, (now - fadeAtRef.current) / LINK_FADE_MS)
    fadeAtRef.current = now
    const changed = new Set<string>()
    for (const [id, link] of linksRef.current) {
      const target = link.look.visible ? 1 : 0
      if (link.alpha === target) continue
      link.alpha = target > link.alpha ? Math.min(target, link.alpha + step) : Math.max(target, link.alpha - step)
      changed.add(id)
    }
    showLinks(changed)
    return changed.size > 0
  }, [showLinks])

  const paintOverrides = useCallback((): ReadonlyMap<string, NodeOverride> | null => {
    const overrides = playbackRef.current?.overrides ?? null
    if (!linksRef.current.size) return overrides
    const out = new Map(overrides ?? [])
    for (const [id, link] of linksRef.current) out.set(id, withLink(out.get(id), link.look, link.alpha))
    return out
  }, [])

  /** Where a world's rect stands now, from its node and the layout, with no scene's look. */
  const worldPlace = useCallback((id: string) => {
    const own = indexRef.current.byId.get(id)
    const node = own ?? ghostByIdRef.current.get(id)
    if (!node || !isLive(node)) return null
    const box = own ? restLayoutRef.current.get(id) : undefined
    return { node, x: box?.x ?? node.x, y: box?.y ?? node.y, override: playbackRef.current?.overrides.get(id) }
  }, [])

  /** Worlds within one screen of the view are wanted. */
  const placeWorlds = useCallback(() => {
    const [vw, vh] = viewportRef.current
    if (vw < 2 || vh < 2) return
    const camera = cameraRef.current
    const width = vw / camera.zoom
    const height = vh / camera.zoom
    nearWorlds({ x: camera.center[0] - width / 2, y: camera.center[1] - height / 2, width, height }, (id) => {
      const place = worldPlace(id)
      return place && { x: place.x, y: place.y, w: place.node.w, h: place.node.h }
    })
  }, [worldPlace])

  /**
   * Paint the dirty ink layers: in the next animation frame, or with `now`
   * at once (a playback frame: its overrides are in the DOM already, so its
   * ink must reach the canvas in the same frame, or the ink of a scene shows
   * one frame behind the shapes that move with it).
   */
  const requestPaint = useCallback(
    (layers: { committed?: boolean; active?: boolean; playback?: boolean }, now = false) => {
      const dirty = dirtyLayersRef.current
      if (layers.committed) dirty.committed = true
      if (layers.active) dirty.active = true
      if (layers.playback) dirty.playback = true
      if (now && paintFrameRef.current !== null) {
        cancelAnimationFrame(paintFrameRef.current)
        paintFrameRef.current = null
      }
      if (paintFrameRef.current !== null) return
      const paint = (): void => {
        paintFrameRef.current = null
        // The grid, the selection box and the lasso follow the camera in the frame of the ink. Wheel events come faster than frames.
        if (cameraStaleRef.current) {
          cameraStaleRef.current = false
          if (now) setCamera(cameraRef.current)
          else flushSync(() => setCamera(cameraRef.current))
        }
        // First the worlds: a new picture moves the items linked to it, and they paint in this same paint.
        syncWorlds(hostRef.current, cameraRef.current, viewportRef.current)
        placeWorlds()
        if (moveRef.current) {
          moveWorlds(moveRef.current, streamRef.current?.id ?? null)
          moveRef.current = null
        }
        const fading = fadeLinks()
        const dirty = dirtyLayersRef.current
        dirtyLayersRef.current = { committed: false, active: false, playback: false }
        // The learner's stroke first: it never waits for the scene's ink.
        if (dirty.active) activeLayerRef.current.paint(penRef.current, activeInkRef.current, activeTailRef.current, activeRef.current, viewportRef.current, cameraRef.current)
        if (dirty.committed) applyContentTransform()
        let again = false
        if (dirty.committed || dirty.playback) {
          const frame = playbackRef.current
          again = inkLayersRef.current.paint(inkRef.current, liveInkRef.current, {
            inks: paintInks(),
            ghosts: ghostInks(),
            transients: (frame?.inks ?? []) as readonly InkNode[],
            overrides: paintOverrides(),
            tips: (frame?.tips ?? []).map((tip) => (tip.follows ? linkedTip(tip, worldPointsRef.current) : tip)),
            selected: selectedIdsRef.current,
            viewport: viewportRef.current,
            camera: cameraRef.current
          })
        }
        if (fading || again) requestPaint({ playback: again })
      }
      if (now) paint()
      else paintFrameRef.current = requestAnimationFrame(paint)
    },
    [applyContentTransform, fadeLinks, ghostInks, paintInks, paintOverrides, placeWorlds]
  )
  // A cancelled frame must also clear its slot. React runs this cleanup and then
  // mounts again (StrictMode in dev, Fast Refresh): a slot left set says "a frame
  // is pending" forever, so the ink and the content layer never move again.
  useEffect(
    () => () => {
      cancelFrame(paintFrameRef)
      cancelFrame(measureFrameRef)
      inkLayersRef.current.dispose()
    },
    []
  )

  // The world surface of this board: it asks for paints and reads where each world stands now.
  useLayoutEffect(() => {
    const board = hostRef.current
    if (!board) return
    return bindWorldBoard(board, {
      paint: () => requestPaint({}),
      points: followPoints,
      place: worldPlace,
      anchor: (id, dx, dy) => {
        if (dx || dy) anchorsRef.current.set(id, [dx, dy])
        else if (!anchorsRef.current.delete(id)) return
        placeLinks()
        if (selectedIdsRef.current.includes(id)) setLayoutVersion((version) => version + 1)
      },
      wants: () => sendWorldInk(paintInks()),
      cursor: (value) => {
        board.style.cursor = value
      }
    })
  }, [followPoints, paintInks, placeLinks, requestPaint, worldPlace])

  // ---------- Layout cache ----------

  /** Measure every content element into the layout cache, then add ink. `inkOnly`: no content changed, so the boxes stand and setNodes added the ink. */
  const measure = useCallback((inkOnly = false) => {
    measuresRef.current++
    const root = contentRootRef.current
    // Playback transforms are only a look: measure the final layout without them.
    const applied = appliedRef.current
    const playing = !inkOnly && applied.size > 0
    if (!inkOnly) {
      if (playing) for (const element of applied.values()) clearElementOverride(element)
      applied.clear()
      const layout: LayoutMap = root ? measureContent(root, elementsRef.current, domCameraRef.current.zoom) : new Map()
      addInkLayout(indexRef.current, layout)
      restLayoutRef.current = layout
    }
    // An item that lost its link or left the board shows no link any more.
    const linked = new Set(linkedNodes().map((node) => node.id))
    for (const id of linksRef.current.keys()) if (!linked.has(id)) linksRef.current.delete(id)
    followPoints(worldPointsRef.current)
    placeLinks()
    sendWorldInk(paintInks())
    // Back on, from the new layout (an element's transform is relative to its layout box).
    if (playing || playbackRef.current || linksRef.current.size) applyPlaybackRef.current()
    setLayoutVersion((version) => version + 1)
    requestPaint({ committed: true })
  }, [followPoints, linkedNodes, paintInks, placeLinks, requestPaint])

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
    // An element's first report is its size as measured after its render: only another size moves anything.
    const observer = new ResizeObserver((entries) => {
      const layout = restLayoutRef.current
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.nodeId
        const box = id ? layout.get(id) : undefined
        const size = entry.borderBoxSize?.[0]
        if (box && size && Math.abs(box.width - size.inlineSize) < 0.05 && Math.abs(box.height - size.blockSize) < 0.05) continue
        requestMeasure()
        return
      }
    })
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
    // A commit of ink only leaves every box where it is, and on a big board a measure of the DOM is the cost of the commit.
    const content = [...index.byId.values()].filter((node) => !isInk(node))
    const last = measuredRef.current
    const inkOnly = !!last && last.editingId === editingId && last.ghostIndex === ghostIndex && last.content.length === content.length && content.every((node, i) => node === last.content[i])
    measuredRef.current = { content, editingId, ghostIndex }
    // It also puts the playback overrides back on every element (a new one, as a ghost, needs its override now).
    measure(inkOnly)
  }, [index, editingId, ghostIndex, applyContentTransform, measure])

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
      const layout = new Map(restLayoutRef.current)
      for (const id of layout.keys()) if (!nextIndex.byId.has(id)) layout.delete(id)
      addInkLayout(nextIndex, layout)
      restLayoutRef.current = layout
      placeLinks()
      setIndex(nextIndex)
      requestPaint({ committed: true })
    },
    [placeLinks, requestPaint]
  )

  // ---------- Camera ----------

  const applyCamera = useCallback(
    (next: Camera) => {
      cameraRef.current = next
      cameraStaleRef.current = true
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

  /** Apply a resize drag to the document under it. */
  const resizeTo = useCallback((drag: DragState): BoardNode[] => {
    const info = drag.resize
    if (!info) return drag.startNodes
    const startById = new Map(drag.startNodes.map((node) => [node.id, node]))
    const node = startById.get(info.id)
    if (!node || !isKnown(node)) return drag.startNodes
    const byId = indexRef.current.byId
    const aspect = !!drag.keepAspect || (node.kind === 'image' && info.handle.length === 2)
    const next = resizedBox(info.box, info.handle, drag.delta ?? [0, 0], aspect)
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
    } else if (isLive(node)) {
      const flowed = isFlowed(node, byId)
      updated = { ...node, w: next.width, h: next.height, ...(flowed ? {} : { x: node.x + dx, y: node.y + dy }) }
    } else {
      const content = node as ContentNode
      const style: NodeStyle = { ...content.style, width: px(next.width) }
      if (content.kind === 'text') delete style.height
      else style.height = px(next.height)
      const flowed = isFlowed(content, byId)
      updated = { ...content, style, ...(flowed ? {} : { x: content.x + dx, y: content.y + dy }) } as BoardNode
    }
    return drag.startNodes.map((entry) => (entry.id === info.id ? updated : entry))
  }, [])

  /** What the board shows during a drag: the document under it, with the drag on top. The one way to show a drag, so a commit under it stays. */
  const dragView = useCallback(
    (drag: DragState): BoardNode[] => {
      if (!drag.changed) return drag.startNodes
      if (drag.kind === 'move' && drag.moveIds) return moveNodes(drag.startNodes, drag.moveIds, drag.delta ?? [0, 0])
      if (drag.kind === 'resize') return resizeTo(drag)
      if (drag.kind === 'erase' && drag.erased) return drag.startNodes.filter((node) => !drag.erased?.has(node.id))
      return drag.startNodes
    },
    [resizeTo]
  )

  /** The drag that shows on the nodes: a stroke, a pan or a lasso does not change them. */
  const openDrag = useCallback((): DragState | null => {
    const drag = dragRef.current
    return drag && (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'erase') ? drag : null
  }, [])

  /** The document: the nodes of the last commit, without what the learner has open. */
  const documentNodes = useCallback((): BoardNode[] => openDrag()?.startNodes ?? editingRef.current?.snapshot ?? nodesRef.current, [openDrag])

  const emit = useCallback(() => {
    onDocChangeRef.current({ ...(idRef.current ? { id: idRef.current } : {}), nextSeq: nextSeqRef.current, nodes: documentNodes(), extra: extraRef.current })
  }, [documentNodes])

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
    (changedNodes: BoardNode[], snapshot: BoardNode[] = nodesRef.current, by: Author = 'learner', record = true) => {
      const next = withoutLostPins(changedNodes)
      if (next.length === snapshot.length && next.every((node, i) => node === snapshot[i])) {
        if (nodesRef.current !== snapshot) setNodes(snapshot)
        return false
      }
      if (record) history.record(snapshot)
      // A learner's edit ends an agent's keyed step: the next keyed commit is a new undo step.
      if (by === 'learner') stepKeyRef.current = null
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
      onChangesRef.current?.({ removed, revisions: stamped.revisions, by })
      // The new document, also when this commit ends a drag or an editor.
      const drag = openDrag()
      if (drag?.startNodes === snapshot) drag.startNodes = stamped.nodes
      if (editingRef.current?.snapshot === snapshot) editingRef.current.snapshot = stamped.nodes
      emit()
      return true
    },
    [emit, history, openDrag, setNodes]
  )

  /**
   * Commit a change that does not come from the learner's open gesture (an agent edit, a
   * pin) to the document under it. The gesture stays open and shows on the new document;
   * its own commit is a later undo step on top of this one.
   */
  const commitOver = useCallback(
    (change: (document: BoardNode[]) => BoardNode[], by: Author, record: boolean): boolean => {
      const drag = openDrag()
      const editing = editingRef.current
      const held = editing ? indexRef.current.byId.get(editing.id) : undefined
      const document = documentNodes()
      const changed = commitNodes(change(document), document, by, record)
      if (drag) setNodes(dragView(drag))
      else if (editing && held) {
        const found = nodesRef.current.some((node) => node.id === held.id)
        setNodes(found ? nodesRef.current.map((node) => (node.id === held.id ? held : node)) : [...nodesRef.current, held])
      }
      return changed
    },
    [commitNodes, documentNodes, dragView, openDrag, setNodes]
  )

  /** An item whose frame left the board stays where it shows: top level, at its world place. So an item that came into a frame since an agent edit's base outlives that edit. */
  const homeless = useCallback((nodes: BoardNode[]): BoardNode[] => {
    const ids = new Set(nodes.map((node) => node.id))
    const lost = (node: BoardNode): boolean => typeof node.parent === 'string' && !ids.has(node.parent)
    if (!nodes.some(lost)) return nodes
    const layout = restLayoutRef.current
    let z = zAbove(indexRef.current.children.get(ROOT) ?? [])
    return nodes.map((node) => {
      if (!lost(node) || !isKnown(node)) return node
      const box = layout.get(node.id)
      const { parent: _parent, ...free } = node as BoardNode & { parent?: string }
      if (!box) return { ...free, z: z++ } as BoardNode
      return { ...free, x: isInk(node) ? box.ox : box.x, y: isInk(node) ? box.oy : box.y, z: z++ } as BoardNode
    })
  }, [])

  /**
   * A mark stays on a part of a world: pick at its centre; on a hit, the world
   * keeps a pin and the mark follows it. No undo step of its own: the undo of
   * the stroke takes the pin too. No hit: it stays ordinary ink.
   */
  const pinMark = useCallback(
    async (id: string, by: Author) => {
      const box = layoutRef.current.get(id)
      const worlds = markWorlds()
      if (!box || !worlds.length) return
      const center: Point = [box.x + box.width / 2, box.y + box.height / 2]
      const found = await pickWorlds(worlds, center[0], center[1], PICK_MARK_MS)
      const part = found?.hit.part
      if (!found || !part) return
      commitOver(
        (nodes) => {
          const mark = nodes.find((node) => node.id === id)
          if (!mark || !isKnown(mark) || mark.follows) return nodes
          const pin = { id, part, local: found.hit.local }
          return nodes.map((node) => {
            if (node.id === id) return { ...node, follows: { world: found.id, point: `pin:${id}`, offset: [-center[0], -center[1]] } } as BoardNode
            if (node.id === found.id) return { ...node, pins: [...((node as LiveNode).pins ?? []), pin] } as BoardNode
            return node
          })
        },
        by,
        false
      )
    },
    [commitOver]
  )

  /** Undo or redo: the restored nodes count as changed, so they get a new seq. */
  const restore = useCallback(
    (snapshot: BoardNode[] | null) => {
      if (!snapshot) return
      stepKeyRef.current = null
      const firstSeq = nextSeqRef.current
      const stamped = stampChanged(nodesRef.current, snapshot, nextSeqRef.current)
      nextSeqRef.current = stamped.nextSeq
      // Undo and redo are the learner's own actions (agents have no undo).
      const now = Date.now()
      for (const node of stamped.nodes) {
        if (node.seq < firstSeq) continue
        editorsRef.current.set(node.id, 'learner')
        timesRef.current.set(node.id, now)
      }
      const removed = stamped.removed.map((removal) => ({ ...removal, bounds: layoutRef.current.get(removal.node.id) ?? null, by: 'learner' as const }))
      setNodes(stamped.nodes)
      onChangesRef.current?.({ removed, revisions: stamped.revisions, by: 'learner' })
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
      commitOver((nodes) => nodes.map((node) => changes.get(node.id) ?? node), 'learner', true)
    },
    [commitOver]
  )

  const eraseAt = useCallback(
    (screen: Point) => {
      const point = screenToBoard(screen, viewportRef.current, cameraRef.current)
      const radius = ERASE_RADIUS / cameraRef.current.zoom
      const layout = layoutRef.current
      const drag = dragRef.current
      if (!drag) return
      let hit = false
      for (const node of nodesRef.current) {
        if (!isInk(node) || !shown(node)) continue
        const box = layout.get(node.id)
        const offset: Point = box ? [box.ox, box.oy] : inkOffset(node, indexRef.current.byId, layout)
        if (!strokeHitByCircle(node, offset, point, radius)) continue
        ;(drag.erased ??= new Set()).add(node.id)
        hit = true
      }
      if (hit) {
        drag.changed = true
        setNodes(dragView(drag))
        if (selectedIdsRef.current.length) setSelectedIds([])
      }
    },
    [dragView, setNodes, setSelectedIds, shown]
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
    index: ghostIndex ?? NO_INDEX,
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
    return inkAt(index, layout, point, TAP_SIZE / cameraRef.current.zoom, shown) ?? contentAt(index, layout, point, shown)
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

  /** The board's own handling of a press. */
  const boardPress = (event: React.PointerEvent<HTMLDivElement>): void => {
    // A press on the board (outside the entered item's frame) leaves the item.
    if (enteredLive()) enterLive(null)
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
      const hit = contentAt(indexRef.current, layoutRef.current, startBoard, shown)
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
      host.setPointerCapture(event.pointerId)
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

  const worldPointer = (kind: WorldPointer['kind'], event: React.PointerEvent<HTMLDivElement>): WorldPointer => {
    const host = hostRef.current as HTMLDivElement
    const [x, y] = screenToBoard(cssPoint(event, host.getBoundingClientRect()), viewportRef.current, cameraRef.current)
    return { kind, x, y, buttons: event.buttons, pressure: event.pressure, pointerType: event.pointerType, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey }
  }

  /** A press that waits or that goes to a world takes its pointer's events. True: the board does nothing. */
  const relayPointer = (kind: 'move' | 'up' | 'cancel', event: React.PointerEvent<HTMLDivElement>): boolean => {
    const hold = holdRef.current
    if (hold?.pointerId === event.pointerId) {
      hold.events.push([kind, event])
      return true
    }
    const stream = streamRef.current
    if (stream?.pointerId === event.pointerId) {
      sendWorldPointer(stream.id, worldPointer(kind, event))
      if (kind !== 'move') streamRef.current = null
      return true
    }
    if (kind === 'move' && wantsPointerMoves()) {
      moveRef.current = worldPointer('move', event)
      requestPaint({})
    }
    return false
  }

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (relayPointer('move', event)) return
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
      drag.delta = boardDelta
      setNodes(dragView(drag))
    } else if (drag.kind === 'resize') {
      drag.delta = [(screen[0] - drag.start[0]) / zoom, (screen[1] - drag.start[1]) / zoom]
      drag.keepAspect = event.shiftKey
      drag.changed = true
      setNodes(dragView(drag))
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
    const frames = (index.children.get(ROOT) ?? []).filter(isInkHost).filter((frame) => frame.style.display !== 'none')
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
    void pinMark(node.id, 'learner')
  }

  const commitStrokeRef = useRef(commitStroke)
  commitStrokeRef.current = commitStroke

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (relayPointer('up', event)) return
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
          if (!isContent(node) || !shown(node)) continue
          const box = layout.get(node.id)
          if (box && regionInsidePolygon(box, polygon)) picked.push(node.id)
        }
        for (const node of inkPaintOrder(index)) {
          if (!shown(node)) continue
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
    if (relayPointer('cancel', event)) return
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

  /**
   * A press. A world that takes input has no box, so only the world can say
   * what is under the pointer: the press waits for its answer, at most
   * PICK_HOLD_MS. A hit: the stream goes to the world. A miss: the board
   * handles the press and what came after it, as if it had just happened.
   */
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // The text editor handles its own pointer input.
    if (event.target instanceof HTMLTextAreaElement) return
    const host = hostRef.current
    const penEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
    const worlds = host && event.button === 0 && !spaceRef.current && !penEraser && tool !== 'eraser' && !holdRef.current && !streamRef.current ? pressWorlds() : []
    if (!host || !worlds.length) {
      boardPress(event)
      return
    }
    event.preventDefault()
    const hold: NonNullable<typeof holdRef.current> = { pointerId: event.pointerId, events: [] }
    holdRef.current = hold
    try {
      host.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture may be unavailable.
    }
    const start = worldPointer('down', event)
    void pickWorlds(worlds, start.x, start.y, PICK_HOLD_MS).then((found) => {
      holdRef.current = null
      if (found) {
        streamRef.current = { id: found.id, pointerId: event.pointerId }
        sendWorldPointer(found.id, start)
        for (const [kind, later] of hold.events) relayPointer(kind, later)
        return
      }
      boardPress(event)
      for (const [kind, later] of hold.events) (kind === 'move' ? pointerMove : kind === 'up' ? pointerUp : pointerCancel)(later)
    })
  }

  /** Double-click: drill into a frame (Figma style); on text, edit it. */
  const doubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (tool !== 'select' || event.target instanceof HTMLTextAreaElement) return
    const host = hostRef.current
    if (!host) return
    const point = screenToBoard(cssPoint(event, host.getBoundingClientRect()), viewportRef.current, cameraRef.current)
    // A world that takes input on entering: on something in it.
    const worlds = enterWorlds()
    if (worlds.length) void pickWorlds(worlds, point[0], point[1], PICK_MARK_MS).then((found) => found && enterLive(found.id))
    const index = indexRef.current
    if (inkAt(index, layoutRef.current, point, TAP_SIZE / cameraRef.current.zoom, shown)) return
    const hit = contentAt(index, layoutRef.current, point, shown)
    if (!hit) return
    const selected = selectedIdsRef.current.length === 1 ? index.byId.get(selectedIdsRef.current[0]) : undefined
    let target: BoardNode
    if (selected && selected.id === hit.id) target = hit
    else if (selected && isFrame(selected)) target = selectTarget(hit, selected.id, index.byId)
    else target = selectTarget(hit, selectionScope(), index.byId)
    if (target.kind === 'text' && target.id === hit.id && isKnown(target) && !target.locked) startEditing(target.id)
    else {
      setSelectedIds([target.id])
    }
  }

  // ---------- Wheel: trackpad pan, pinch zoom, ⌘ + scroll zoom ----------

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wheel = (event: WheelEvent): void => {
      // The world the learner entered takes the wheel.
      const entered = enteredWorld()
      if (entered) {
        event.preventDefault()
        const rect = host.getBoundingClientRect()
        const [x, y] = screenToBoard([event.clientX - rect.left, event.clientY - rect.top], viewportRef.current, cameraRef.current)
        sendWorldPointer(entered, { kind: 'wheel', x, y, buttons: event.buttons, pressure: 0, pointerType: 'mouse', deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey })
        return
      }
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
      worldPoint: (world, point) => {
        const p = pointNow(worldPointsRef.current, world, point)
        return p ? [p[0], p[1]] : null
      },
      worldPoints: () => worldPointsRef.current,
      pinMark: (id, by) => void pinMark(id, by),
      animateTo: (target, ms = 420, held, follow) => {
        const token = ++glideRef.current
        const from = cameraRef.current
        let last = performance.now()
        let elapsed = 0
        const step = (): void => {
          if (glideRef.current !== token) return
          const now = performance.now()
          if (!held?.()) elapsed += now - last
          last = now
          const t = Math.min(1, elapsed / Math.max(1, ms))
          const aim = follow?.() ?? null
          applyCamera(glideCamera(from, aim ? { ...target, center: aim } : target, t))
          if (t < 1 || aim) requestAnimationFrame(step)
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
      agentCommit: (base, next, options) => {
        // An agent edit ends a learner's text editing first, so the two never mix.
        if (editingRef.current) commitEditing()
        const key = options?.step ?? null
        const join = key !== null && stepKeyRef.current === key
        let changed = false
        const measures = measuresRef.current
        flushSync(() => {
          changed = commitOver((document) => homeless(applyChanges(document, base, next)), 'agent', !join)
        })
        if (changed || join) stepKeyRef.current = key
        // The commit's render measured, unless it rendered nothing.
        if (measuresRef.current === measures) measure()
        const present = new Set(documentNodes().map((node) => node.id))
        if (selectedIdsRef.current.some((id) => !present.has(id))) setSelectedIds(selectedIdsRef.current.filter((id) => present.has(id)))
      },
      agentAmend: (base, next) => {
        if (editingRef.current) commitEditing()
        const measures = measuresRef.current
        flushSync(() => commitOver((document) => homeless(applyChanges(document, base, next)), 'agent', false))
        if (measuresRef.current === measures) measure()
      },
      boardId: () => idRef.current,
      setBoardId: (id) => {
        if (idRef.current === id) return
        idRef.current = id
        emit()
      },
      remeasure: () => measure(),
      selectAll: () => selectAllRef.current(),
      settle: () => {
        if (editingRef.current) commitEditing()
        const drag = dragRef.current
        const stroke = activeRef.current
        if (drag?.kind !== 'ink' || !stroke) return
        dragRef.current = null
        activeRef.current = null
        commitStrokeRef.current({ ...stroke, points: [...stroke.points] })
        requestPaint({ active: true })
      },
      setPlayback: (frame) => {
        const ghosts = frame?.ghosts ?? []
        const ghostsChanged = ghosts !== ghostNodesRef.current
        playbackRef.current = frame
        if (ghostsChanged) {
          ghostNodesRef.current = ghosts
          ghostByIdRef.current = new Map(ghosts.map((node) => [node.id, node]))
          const content = ghosts.filter((node) => !isInk(node))
          // The ghost layer renders before this returns, so its elements get their overrides now.
          flushSync(() => setGhostIndex(content.length ? buildIndex(content) : null))
        }
        const changed = ghostsChanged ? null : (frame?.changed ?? null)
        applyPlaybackToDom(changed)
        inkLayersRef.current.note(frame ? changed : null)
        // The ink canvas paints again when an ink node's override changed, or for pen tips and changing ink.
        const moment = inkMomentRef.current
        const tips = frame?.tips.length ?? 0
        const inks = frame?.inks?.length ?? 0
        let ink = !frame || !changed || tips > 0 || inks > 0 || moment.tips > 0 || moment.inks > 0
        if (!ink && changed) {
          const byId = indexRef.current.byId
          for (const id of changed) {
            const node = byId.get(id) ?? ghostByIdRef.current.get(id)
            if (node && isInk(node)) {
              ink = true
              break
            }
          }
        }
        inkMomentRef.current = { tips, inks }
        // In this frame, with the overrides that applyPlaybackToDom just put in the DOM.
        // Worlds read their look in the paint, whether or not ink changed.
        if (ink || hasWorlds(hostRef.current)) requestPaint({ playback: ink }, true)
        // The end of playback: measure the final layout once more.
        if (!frame) requestMeasure()
      }
    }),
    [applyCamera, applyColor, applyPlaybackToDom, applyWidth, commitEditing, commitOver, documentNodes, emit, fit, homeless, measure, paintInks, requestMeasure, requestPaint, setSelectedIds, zoomStep]
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
    setSelectedIds((indexRef.current.children.get(ROOT) ?? []).filter(shown).map((node) => node.id))
  }, [setSelectedIds, shown])

  const applyAction = (action: BoardKeyAction): void => {
    // A key edit needs the document, not a drag on top of it: the drag ends as Escape ends it.
    if (openDrag()) cancelDrag()
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
        const copy = { ...withoutScene(node), id: idMap.get(node.id) as string } as BoardNode & { parent?: string }
        if (typeof node.parent === 'string' && idMap.has(node.parent)) copy.parent = idMap.get(node.parent)
        if (roots.has(node.id) && isKnown(node)) {
          return { ...copy, x: node.x - minX + anchor[0], y: node.y - minY + anchor[1], z: z++ } as BoardNode
        }
        return copy as BoardNode
      })
      commitNodes([...nodesRef.current, ...(copiedLinks(nodes, idMap))])
      setSelectedIds(clip.roots.map((id) => idMap.get(id) as string))
      pasteAnchorRef.current = null
    }
  }

  const nudge = (dx: number, dy: number): void => {
    if (openDrag()) cancelDrag()
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
      if (enteredLive()) enterLive(null)
      else if (dragRef.current) cancelDrag()
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
      <canvas className="board__world" aria-hidden="true" />
      <canvas className="board__ink" ref={inkRef} />
      <canvas className="board__ink board__ink--live" ref={liveInkRef} aria-hidden="true" />
      <div className="board__pen" ref={penRef} aria-hidden="true">
        <canvas className="board__active" ref={activeInkRef} />
        <canvas className="board__active" ref={activeTailRef} />
      </div>
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
