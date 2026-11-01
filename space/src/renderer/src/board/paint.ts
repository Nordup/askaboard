import { inkBounds, pressureWidth, regionsIntersect } from './geometry'
import { InkGrid, TileCache, tileLevel, type TileContext } from './ink-tiles'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackMatrix, type PlaybackTip } from './playback'
import type { Camera, InkNode, Point, Region } from './types'

type StrokeItem = InkNode

/** A canvas or a tile: stroke code draws on both. */
type InkContext = CanvasRenderingContext2D | TileContext

/** An ink node with its world offset (the world position of its local 0,0). */
export interface PaintInk {
  node: InkNode
  offset: Point
}

/** Highlighter ink is translucent and sits under pen ink. */
export const HIGHLIGHTER_ALPHA = 0.55

/** The device pixel of board point 0,0: a whole pixel, so that every ink layer and every tile shows the same pixels at any pan. */
function inkOrigin(viewport: Point, camera: Camera, dpr: number): Point {
  return [Math.round(dpr * (viewport[0] / 2 - camera.center[0] * camera.zoom)), Math.round(dpr * (viewport[1] / 2 - camera.center[1] * camera.zoom))]
}

/** The box around a region under a matrix. */
function matrixBounds(region: Region, [a, b, c, d, e, f]: PlaybackMatrix): Region {
  const xs = [region.x, region.x + region.width]
  const ys = [region.y, region.y + region.height]
  const px = xs.flatMap((x) => ys.map((y) => a * x + c * y + e))
  const py = xs.flatMap((x) => ys.map((y) => b * x + d * y + f))
  const x = Math.min(...px)
  const y = Math.min(...py)
  return { x, y, width: Math.max(...px) - x, height: Math.max(...py) - y }
}

/**
 * Size the canvas backing store for the viewport and device pixel ratio,
 * clear it, and set the board transform. Returns null when there is no 2D context.
 */
function prepare(canvas: HTMLCanvasElement, viewport: Point, camera: Camera): CanvasRenderingContext2D | null {
  const [width, height] = viewport
  const dpr = window.devicePixelRatio || 1
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  const context = canvas.getContext('2d')
  if (!context) return null
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, pixelWidth, pixelHeight)
  const [tx, ty] = inkOrigin(viewport, camera, dpr)
  context.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, tx, ty)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  return context
}

/** The visible board region, with a margin. */
function visibleRegion(viewport: Point, camera: Camera): Region {
  const width = viewport[0] / camera.zoom
  const height = viewport[1] / camera.zoom
  const margin = 32 / camera.zoom
  return {
    x: camera.center[0] - width / 2 - margin,
    y: camera.center[1] - height / 2 - margin,
    width: width + margin * 2,
    height: height + margin * 2
  }
}

/** A smooth path through the points: quadratic curves between segment midpoints. */
function tracePath(context: InkContext | Path2D, points: StrokeItem['points']): void {
  context.moveTo(points[0][0], points[0][1])
  if (points.length === 2) {
    context.lineTo(points[1][0], points[1][1])
    return
  }
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    context.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2)
  }
  const last = points[points.length - 1]
  context.lineTo(last[0], last[1])
}

/** Write piece i of these points at `at`, 7 numbers: start, control point and end, then the share of the stroke's width. Piece i runs from the midpoint before sample i to the midpoint after it. */
function writePiece(out: Float64Array, at: number, points: StrokeItem['points'], i: number): void {
  const last = points.length - 1
  const [x, y, p] = points[i]
  const [px, py] = points[Math.max(0, i - 1)]
  const [nx, ny] = points[Math.min(last, i + 1)]
  out[at] = (px + x) / 2
  out[at + 1] = (py + y) / 2
  out[at + 2] = x
  out[at + 3] = y
  out[at + 4] = (x + nx) / 2
  out[at + 5] = (y + ny) / 2
  out[at + 6] = pressureWidth(p)
}

/** The pieces of pressure ink. */
function piecesOf(points: StrokeItem['points']): Float64Array {
  const pieces = new Float64Array(points.length * 7)
  for (let i = 0; i < points.length; i++) writePiece(pieces, i * 7, points, i)
  return pieces
}

/** Stroke the first `end` numbers of a list of pieces. */
function strokePieces(context: InkContext, pieces: Float64Array, end: number, width: number, minWidth: number): void {
  for (let at = 0; at < end; at += 7) {
    context.lineWidth = Math.max(minWidth, width * pieces[at + 6])
    context.beginPath()
    context.moveTo(pieces[at], pieces[at + 1])
    context.quadraticCurveTo(pieces[at + 2], pieces[at + 3], pieces[at + 4], pieces[at + 5])
    context.stroke()
  }
}

/** What a stroke costs to work out once for each tile that it touches. */
interface StrokeShape {
  /** The first sample whose pressure differs from the first sample's: the length of the stroke when none does. */
  firstChange: number
  path: Path2D | null
  pieces: Float64Array | null
  /** What `path` and `pieces` hold. */
  bytes: number
}

/** By the points of a committed node, which never change, so a path is built once. A change of colour keeps them. */
const shapes = new WeakMap<StrokeItem['points'], StrokeShape>()

/** The bytes of the paths and pieces that strokes keep, at most. Over this, the shapes used longest ago give them up, and their next draw builds them again. */
const MAX_SHAPE_BYTES = 32 * 1024 * 1024
/** About the bytes of a path per sample: a curve of the native path. */
const PATH_SAMPLE_BYTES = 40
const PIECE_SAMPLE_BYTES = 56
/** The shapes that hold a path or pieces, the one used longest ago first. It holds no points, so a board that goes frees them. */
const heldShapes = new Set<StrokeShape>()
let heldShapeBytes = 0

/** What strokes keep of their paths and pieces now (dev checks). */
export const strokeShapeBytes = (): number => heldShapeBytes

function shapeOf(points: StrokeItem['points']): StrokeShape {
  let shape = shapes.get(points)
  if (!shape) {
    const change = points.findIndex((point) => point[2] !== points[0][2])
    shapes.set(points, (shape = { firstChange: change < 0 ? points.length : change, path: null, pieces: null, bytes: 0 }))
  }
  return shape
}

/** The shape was used: it goes last in the line. */
function touchShape(shape: StrokeShape): void {
  heldShapes.delete(shape)
  heldShapes.add(shape)
}

/** The shape took on `bytes` more: the shapes used longest ago give up theirs, as far as the budget needs it. */
function growShape(shape: StrokeShape, bytes: number): void {
  shape.bytes += bytes
  heldShapeBytes += bytes
  touchShape(shape)
  for (const old of heldShapes) {
    if (heldShapeBytes <= MAX_SHAPE_BYTES) break
    heldShapes.delete(old)
    heldShapeBytes -= old.bytes
    old.bytes = 0
    old.path = null
    old.pieces = null
  }
}

function shapePath(shape: StrokeShape, points: StrokeItem['points']): Path2D {
  if (shape.path) {
    touchShape(shape)
    return shape.path
  }
  const path = new Path2D()
  tracePath(path, points)
  shape.path = path
  growShape(shape, points.length * PATH_SAMPLE_BYTES)
  return path
}

function shapePieces(shape: StrokeShape, points: StrokeItem['points']): Float64Array {
  if (shape.pieces) {
    touchShape(shape)
    return shape.pieces
  }
  const pieces = piecesOf(points)
  shape.pieces = pieces
  growShape(shape, points.length * PIECE_SAMPLE_BYTES)
  return pieces
}

const evenPressure = (points: StrokeItem['points']): boolean => points.every((point) => point[2] === points[0][2])

/** The last two pieces of a partly drawn stroke, which change with each frame. */
const revealTail = new Float64Array(14)

/**
 * Draw one ink node at its world offset; a playback override moves, fades, recolours or partly draws it.
 * committed: the node is on the board, so its points never change. Ink of a stream is not.
 */
function drawInk(context: InkContext, ink: PaintInk, minWidth = 0, override?: NodeOverride, committed = false): void {
  context.save()
  if (override?.matrix) context.transform(...override.matrix)
  context.translate(ink.offset[0], ink.offset[1])
  const whole = committed ? ink.node.points : undefined
  if (override && (override.reveal !== undefined || override.color !== undefined)) {
    const points = override.reveal === undefined ? ink.node.points : revealPoints(ink.node.points, override.reveal)
    drawStroke(context, { ...ink.node, points, color: override.color ?? ink.node.color }, minWidth, override.opacity ?? 1, whole)
  } else drawStroke(context, ink.node, minWidth, override?.opacity ?? 1, whole)
  context.restore()
}

/**
 * `minWidth`: the thinnest line to draw, in board points (offscreen export only). `alpha` multiplies the ink's own.
 * `whole`: the points of a committed node, which never change, so their shape is kept. The stroke's points are these, or the start of them with one more point at the end (revealPoints).
 */
function drawStroke(context: InkContext, stroke: StrokeItem, minWidth = 0, alpha = 1, whole?: StrokeItem['points']): void {
  const points = stroke.points
  if (!points.length || alpha <= 0) return
  context.strokeStyle = stroke.color
  context.fillStyle = stroke.color
  const highlighter = stroke.tool === 'highlighter'
  context.globalAlpha = (highlighter ? HIGHLIGHTER_ALPHA : 1) * Math.min(1, alpha)

  if (points.length === 1) {
    const [x, y, p] = points[0]
    const radius = Math.max(minWidth, stroke.width * (highlighter ? 1 : pressureWidth(p))) / 2
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1
    return
  }

  // One path for highlighters and constant-pressure ink: a translucent path
  // must not darken where its own segments overlap.
  const shape = whole ? shapeOf(whole) : null
  const last = points.length - 1
  // All samples before the last are samples of the whole stroke, so its first change says if they are even.
  if (highlighter || (shape ? last <= shape.firstChange && points[last][2] === points[0][2] : evenPressure(points))) {
    context.lineWidth = Math.max(minWidth, stroke.width * (highlighter ? 1 : pressureWidth(points[0][2])))
    if (shape && points === whole) context.stroke(shapePath(shape, points))
    else {
      context.beginPath()
      tracePath(context, points)
      context.stroke()
    }
    context.globalAlpha = 1
    return
  }

  // Pressure ink: one curve piece per sample, each with its own width. A Path2D per piece would
  // hold hundreds of objects per stroke, so the numbers of the pieces are what stays.
  if (shape && whole && points !== whole) {
    // A reveal: each piece but the last two needs only samples of the whole stroke, so it is that stroke's piece. The last two end at the point that moves.
    const done = last - 1
    if (done > 0) strokePieces(context, shapePieces(shape, whole), done * 7, stroke.width, minWidth)
    writePiece(revealTail, 0, points, done)
    writePiece(revealTail, 7, points, last)
    strokePieces(context, revealTail, 14, stroke.width, minWidth)
  } else {
    const pieces = shape ? shapePieces(shape, points) : piecesOf(points)
    strokePieces(context, pieces, pieces.length, stroke.width, minWidth)
  }
  context.globalAlpha = 1
}

/** The selection glow colour (the --accent token). */
const SELECTION_GLOW = '#6e8bff'

/** A soft accent band under a selected stroke, a few screen pixels wider than its ink. */
function drawGlow(context: CanvasRenderingContext2D, ink: PaintInk, zoom: number): void {
  const stroke = ink.node
  const points = stroke.points
  if (!points.length) return
  context.save()
  context.translate(ink.offset[0], ink.offset[1])
  const maxPressure = Math.max(...points.map((point) => point[2]))
  const inkWidth = stroke.width * (stroke.tool === 'highlighter' ? 1 : pressureWidth(maxPressure))
  context.strokeStyle = SELECTION_GLOW
  context.fillStyle = SELECTION_GLOW
  context.globalAlpha = 0.45
  context.lineWidth = inkWidth + 7 / zoom
  context.beginPath()
  if (points.length === 1) {
    context.arc(points[0][0], points[0][1], context.lineWidth / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    tracePath(context, points)
    context.stroke()
  }
  context.globalAlpha = 1
  context.restore()
}

/** The pen tip of a live scene: a small dot with a soft halo where the stroke is drawn now. */
function drawTip(context: CanvasRenderingContext2D, point: Point, color: string, size: number, zoom: number): void {
  const radius = Math.max(size / 2 + 1.5, 3 / zoom)
  context.save()
  context.globalAlpha = 0.22
  context.fillStyle = color
  context.beginPath()
  context.arc(point[0], point[1], radius * 2.6, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = 0.95
  context.beginPath()
  context.arc(point[0], point[1], radius, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

/** A live scene's pointer: a ring around a dot, like a tutor's hand pointing. Its size stays the same on screen. */
function drawPointer(context: CanvasRenderingContext2D, point: Point, color: string, size: number, zoom: number, alpha: number): void {
  const radius = size / zoom
  context.save()
  context.globalAlpha = 0.18 * alpha
  context.fillStyle = color
  context.beginPath()
  context.arc(point[0], point[1], radius * 2.2, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = 0.9 * alpha
  context.strokeStyle = color
  context.lineWidth = 2 / zoom
  context.beginPath()
  context.arc(point[0], point[1], radius * 1.3, 0, Math.PI * 2)
  context.stroke()
  context.beginPath()
  context.arc(point[0], point[1], radius * 0.45, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function drawTips(context: CanvasRenderingContext2D, tips: readonly PlaybackTip[], zoom: number): void {
  for (const tip of tips) {
    if (tip.kind === 'pointer') drawPointer(context, tip.point, tip.color, tip.size, zoom, tip.alpha ?? 1)
    else drawTip(context, tip.point, tip.color, tip.size, zoom)
  }
}

/** The board's ink for one paint (see InkLayers). */
export interface InkPaint {
  /** The committed ink in paint order. The same array while it is the same. */
  inks: readonly PaintInk[]
  /** Ghost ink of the playing scenes (removed by a scene). The same array while it is the same. */
  ghosts: readonly PaintInk[]
  /** Ink that exists only now (changing ink objects), in world coordinates. Their points change from frame to frame. */
  transients: readonly InkNode[]
  overrides: ReadonlyMap<string, NodeOverride> | null
  tips: readonly PlaybackTip[]
  selected: readonly string[]
  viewport: Point
  camera: Camera
}

/** How long a stroke counts as changing after its override last changed. */
const HOLD_MS = 300
/** Changing strokes closer than this in the paint order share one run (drawing the strokes between costs less than another picture). */
const RUN_GAP = 48
/** At most this many runs (each run but the first has a cached picture of the strokes before it). */
const MAX_RUNS = 3
/** How many strokes a new run reaches past its last changing stroke: a scene draws its strokes in order. */
const RUN_AHEAD = 16
/** A zoom that stood still this long has stopped: tiles at the scale of the screen follow. */
const SETTLE_MS = 120

type Run = { lo: number; hi: number }

/** The runs [lo, hi) that hold the given positions: positions closer than RUN_GAP share a run, and the closest runs merge down to MAX_RUNS. */
function runsOf(positions: number[]): Run[] {
  positions.sort((a, b) => a - b)
  const runs: Run[] = []
  for (const at of positions) {
    const last = runs[runs.length - 1]
    if (last && at - last.hi < RUN_GAP) last.hi = Math.max(last.hi, at + 1)
    else runs.push({ lo: at, hi: at + 1 })
  }
  while (runs.length > MAX_RUNS) {
    let closest = 0
    for (let i = 1; i < runs.length - 1; i++) if (runs[i + 1].lo - runs[i].hi < runs[closest + 1].lo - runs[closest].hi) closest = i
    runs[closest].hi = runs[closest + 1].hi
    runs.splice(closest + 1, 1)
  }
  return runs
}

const strokesIn = (runs: readonly Run[]): number => runs.reduce((sum, run) => sum + run.hi - run.lo, 0)

/**
 * The board's ink on two canvases, so that a playback frame paints only the
 * ink that changes.
 *
 * The paint order is: selection glow, highlighters, then pen ink (each in
 * board order, ghosts after the committed ink, changing ink after both).
 * The strokes whose override changed in the last HOLD_MS lie in a few runs
 * of this order. The static canvas holds the glow and the strokes before the
 * first run. The live canvas, above it, holds each run (drawn again in each
 * frame), each followed by a cached picture of the strokes up to the next
 * run (the last picture: up to the end), then the changing pen ink and the
 * pen tips. So a stroke that animates under static ink still shows under it,
 * and one animated early stroke does not repaint the unrelated ink after it.
 * The static canvas and the pictures show each stroke with its override of
 * the time they were drawn: a stroke that a scene keeps hidden or keeps
 * still costs nothing per frame.
 *
 * The strokes of the static canvas come from cached tiles (ink-tiles.ts,
 * decision B28), and the glow goes under them. A camera move shows the same
 * tiles at another place, and an edit, a change of override or a change of
 * the first run drops only the tiles under the strokes that changed. While
 * the zoom moves, tiles of a fixed level show; when it stops, tiles at the
 * scale of the screen take their place.
 */
export class InkLayers {
  private inks: readonly PaintInk[] | null = null
  private ghosts: readonly PaintInk[] | null = null
  /** The committed and ghost strokes in paint order, and the position of each. */
  private order: PaintInk[] = []
  private position = new Map<string, number>()
  /** The bounds of each stroke of the order, and the strokes by place. */
  private bounds: Array<Region | null> = []
  private grid = new InkGrid()
  /** Where a scene's matrix holds a stroke now, when it holds one. */
  private moved = new Map<string, Region>()
  /** The count of highlighters at the start of the order (changing highlighters go after them). */
  private highlighters = 0
  /** The strokes of the order that have an override now. */
  private overridden = new Set<string>()
  /** The overrides of this paint: the tiles draw with them. */
  private overrides: ReadonlyMap<string, NodeOverride> | null = null
  /** Nodes whose override changed since the last paint (null: any). */
  private pending: Set<string> | null = null
  /** The strokes whose override changed in the last HOLD_MS, with the time of the last change. */
  private active = new Map<string, number>()
  /** The runs of the order that the live canvas draws in each frame (none: the static canvas holds all strokes). */
  private runs: Run[] = []
  /** The view that the pictures show ('' : not drawn). */
  private view = ''
  /** The view, the selection, the tile scale and the tiles that the static canvas shows. */
  private shown = ''
  /** The end of the strokes in the tiles. */
  private baseEnd = 0
  /** Device pixels per board point at the last paint, and when that last changed. */
  private scale = 0
  private zoomedAt = -Infinity
  /** Tiles still wait for a later paint. */
  private waiting = false
  /** pictures[i]: the strokes [lo, hi) after runs[i], up to the next run or the end. */
  private pictures: Array<{ canvas: HTMLCanvasElement; lo: number; hi: number }> = []
  private liveUsed = false
  private readonly tiles = new TileCache((context, region) => {
    let drew = false
    for (const at of this.strokesIn(region, 0, this.baseEnd)) if (this.drawAt(context, at)) drew = true
    return drew
  })

  /** The overrides of these nodes changed (null: of any node). Call it for each playback frame. */
  note(changed: ReadonlySet<string> | null | undefined): void {
    if (!changed) this.pending = null
    else if (this.pending) for (const id of changed) this.pending.add(id)
  }

  /** What the tile cache holds (dev checks). */
  tileStats(): ReturnType<TileCache['stats']> {
    return this.tiles.stats()
  }

  /** Free the tiles: the board leaves. */
  dispose(): void {
    this.tiles.clear()
  }

  /** The positions in [lo, hi) of the strokes that show in a region, in paint order. */
  private strokesIn(region: Region, lo: number, hi: number): number[] {
    const hit = (at: number): boolean => {
      const place = this.moved.get(this.order[at].node.id) ?? this.bounds[at]
      return !!place && regionsIntersect(place, region)
    }
    if (hi - lo < 256) {
      const out: number[] = []
      for (let at = lo; at < hi; at++) if (hit(at)) out.push(at)
      return out
    }
    const out: number[] = []
    const ids = this.grid.query(region)
    for (const id of this.moved.keys()) ids.add(id)
    for (const id of ids) {
      const at = this.position.get(id)
      if (at !== undefined && at >= lo && at < hi && hit(at)) out.push(at)
    }
    return out.sort((a, b) => a - b)
  }

  /** False: the stroke puts no pixel down now (it has no points, or a scene hides it). */
  private drawAt(context: InkContext, at: number): boolean {
    const ink = this.order[at]
    const override = this.overrides?.get(ink.node.id)
    const points = ink.node.points
    // A one-point stroke has nothing to reveal: it shows whole.
    if (!points.length || (override?.opacity ?? 1) <= 0 || (points.length > 1 && (override?.reveal ?? 1) <= 0)) return false
    drawInk(context, ink, 0, override, true)
    return true
  }

  /** A stroke changes: the tiles under it, where it rests and where a scene holds it, are out of date. */
  private touch(ink: PaintInk): void {
    const place = this.moved.get(ink.node.id)
    if (place) this.tiles.invalidate(place)
    const bounds = inkBounds(ink.node, ink.offset)
    if (bounds) this.tiles.invalidate(bounds)
  }

  /** A new order: tiles go only for strokes that changed. Survivors in another order leave no tile valid. */
  private reorder(next: PaintInk[]): void {
    const old = this.order
    const oldAt = this.position
    const oldBounds = this.bounds
    const position = new Map(next.map((ink, i) => [ink.node.id, i]))
    /** A stroke's new bounds, and its cells in the grid. */
    const place = (ink: PaintInk, was: Region | null): Region | null => {
      const bounds = inkBounds(ink.node, ink.offset)
      if (was) this.grid.remove(ink.node.id, was)
      if (bounds) this.grid.add(ink.node.id, bounds)
      return bounds
    }
    let last = -1
    let sameOrder = true
    const bounds = next.map((ink) => {
      const at = oldAt.get(ink.node.id)
      if (at === undefined) {
        this.touch(ink)
        return place(ink, null)
      }
      if (at < last) sameOrder = false
      last = Math.max(last, at)
      const was = old[at]
      if (was.node === ink.node && was.offset[0] === ink.offset[0] && was.offset[1] === ink.offset[1]) return oldBounds[at]
      this.touch(was)
      this.touch(ink)
      return place(ink, oldBounds[at])
    })
    old.forEach((ink, at) => {
      if (position.has(ink.node.id)) return
      this.touch(ink)
      const was = oldBounds[at]
      if (was) this.grid.remove(ink.node.id, was)
    })
    if (!sameOrder) this.tiles.clear()
    this.order = next
    this.position = position
    this.bounds = bounds
    for (const id of this.moved.keys()) if (!position.has(id)) this.moved.delete(id)
  }

  /** Where the override of a stroke holds it now. */
  private place(at: number): Region | null {
    const ink = this.order[at]
    const matrix = this.overrides?.get(ink.node.id)?.matrix
    const bounds = this.bounds[at]
    return matrix && bounds ? matrixBounds(bounds, matrix) : null
  }

  /** The strokes in the tiles change from the first `end` strokes of `before` (its order and positions) to those of the order now. */
  private respan(end: number, before: { order: readonly PaintInk[]; position: ReadonlyMap<string, number>; end: number }): void {
    const { order, position } = this
    if (before.order === order) {
      for (let at = Math.min(before.end, end); at < Math.max(before.end, end); at++) this.touch(order[at])
    } else if (before.end < before.order.length || end < order.length) {
      for (let at = 0; at < before.end; at++) if ((position.get(before.order[at].node.id) ?? end) >= end) this.touch(before.order[at])
      for (let at = 0; at < end; at++) if ((before.position.get(order[at].node.id) ?? before.end) >= before.end) this.touch(order[at])
    }
    this.baseEnd = end
  }

  /** Paint the ink: the static canvas and the pictures when they are out of date, and the live canvas. True: paint again in the next frame. */
  paint(base: HTMLCanvasElement | null, live: HTMLCanvasElement | null, input: InkPaint): boolean {
    if (!base || !live) return false
    const { overrides, transients, viewport, camera } = input
    this.overrides = overrides
    // The order of the committed and ghost strokes. reordered: the positions are new.
    const before = { order: this.order, position: this.position, end: this.baseEnd }
    let reordered = false
    if (input.inks !== this.inks || input.ghosts !== this.ghosts) {
      this.inks = input.inks
      this.ghosts = input.ghosts
      const all = input.ghosts.length ? [...input.inks, ...input.ghosts] : input.inks
      this.reorder([...all.filter((ink) => ink.node.tool === 'highlighter'), ...all.filter((ink) => ink.node.tool !== 'highlighter')])
      this.highlighters = this.order.findIndex((ink) => ink.node.tool !== 'highlighter')
      if (this.highlighters < 0) this.highlighters = this.order.length
      reordered = true
    }
    // The strokes whose override changed: the noted ones, or all that have or had one.
    const changed = new Set<string>(this.pending ?? [...this.overridden, ...(overrides?.keys() ?? [])])
    // Strokes that arrived with a matrix: the note of their frame came before them.
    if (reordered && overrides) for (const [id, override] of overrides) if (override.matrix && this.position.has(id)) changed.add(id)
    // The strokes with an override now.
    let presence = false
    if (!overrides) {
      presence = this.overridden.size > 0
      this.overridden.clear()
    } else if (this.pending === null || reordered) {
      const next = new Set<string>()
      for (const id of overrides.keys()) if (this.position.has(id)) next.add(id)
      presence = next.size !== this.overridden.size || [...next].some((id) => !this.overridden.has(id))
      this.overridden = next
    } else {
      for (const id of this.pending) {
        if (!this.position.has(id)) continue
        const has = overrides.has(id)
        if (has === this.overridden.has(id)) continue
        if (has) this.overridden.add(id)
        else this.overridden.delete(id)
        presence = true
      }
    }
    this.pending = new Set()
    // The strokes that change now. A change outside the runs makes the layer that holds the stroke out of date.
    const now = performance.now()
    const inRuns = (at: number): boolean => this.runs.some((run) => at >= run.lo && at < run.hi)
    const stale: number[] = []
    for (const id of changed) {
      const at = this.position.get(id)
      if (at === undefined) continue
      this.active.set(id, now)
      const outside = !inRuns(at)
      if (outside) {
        stale.push(at)
        this.touch(this.order[at])
      }
      const place = this.place(at)
      if (place) this.moved.set(id, place)
      else this.moved.delete(id)
      if (outside && place) this.tiles.invalidate(place)
    }
    let rebuild = reordered || stale.length > 0
    // The runs that this frame needs.
    const positions: number[] = []
    for (const [id, changedAt] of this.active) {
      const at = this.position.get(id)
      if (at === undefined || now - changedAt > HOLD_MS) this.active.delete(id)
      else positions.push(at)
    }
    let transientHighlighter = false
    let transientPen = false
    for (const node of transients) {
      if (node.tool === 'highlighter') transientHighlighter = true
      else transientPen = true
    }
    // Changing highlighters go after the highlighters: a run holds that place.
    if (transientHighlighter) positions.push(this.highlighters)
    const needed = runsOf(positions)
    const dpr = window.devicePixelRatio || 1
    const view = `${viewport[0]},${viewport[1]},${dpr},${camera.center[0]},${camera.center[1]},${camera.zoom}`
    let full = reordered
    if (view !== this.view) rebuild = full = true
    else if (!needed.length) rebuild ||= this.runs.length > 0
    else if (needed.some((run) => !this.runs.some((own) => run.lo >= own.lo && run.hi <= own.hi))) rebuild = true
    else if (strokesIn(this.runs) - strokesIn(needed) > Math.max(64, strokesIn(needed))) rebuild = true // much more than needed
    if (rebuild) {
      const n = this.order.length
      const runs = needed.map((run, i) => ({ lo: run.lo, hi: Math.min(n, run.hi + RUN_AHEAD, needed[i + 1]?.lo ?? n) }))
      this.respan(runs.length ? runs[0].lo : n, before)
      this.view = view
      this.drawPictures(input, runs, full, stale)
    }
    const again = this.drawBase(base, input, view, presence, now)
    this.drawLive(live, input, transientHighlighter, transientPen)
    return again
  }

  /** The static canvas: the glow, then the tiles. True: paint again, for tiles that wait or for a zoom that may have stopped. */
  private drawBase(base: HTMLCanvasElement, input: InkPaint, view: string, presence: boolean, now: number): boolean {
    const { viewport, camera, overrides } = input
    const dpr = window.devicePixelRatio || 1
    const scale = camera.zoom * dpr
    if (scale !== this.scale) {
      if (this.scale) this.zoomedAt = now
      this.scale = scale
    }
    const settled = now - this.zoomedAt >= SETTLE_MS
    const target = settled ? scale : tileLevel(scale)
    const shown = `${view}|${input.selected.join(',')}|${target}|${this.tiles.version}`
    if (shown === this.shown && !this.waiting && !(presence && input.selected.length)) return !settled
    const context = prepare(base, viewport, camera)
    if (!context) return false
    if (input.selected.length) {
      const visible = visibleRegion(viewport, camera)
      for (const id of input.selected) {
        const at = this.position.get(id)
        if (at === undefined || overrides?.has(id)) continue
        const bounds = this.bounds[at]
        if (bounds && regionsIntersect(bounds, visible)) drawGlow(context, this.order[at], camera.zoom)
      }
    }
    context.setTransform(1, 0, 0, 1, 0, 0)
    const [tx, ty] = inkOrigin(viewport, camera, dpr)
    this.waiting = this.tiles.compose(context, { scale, target, tx, ty, width: base.width, height: base.height, ring: settled })
    this.shown = `${view}|${input.selected.join(',')}|${target}|${this.tiles.version}`
    return this.waiting || !settled
  }

  /** The pictures after the runs, each stroke with its override now. A picture is drawn again only when its span changed or holds a stale stroke (full: every one). */
  private drawPictures(input: InkPaint, runs: Run[], full: boolean, stale: readonly number[]): void {
    this.runs = runs
    const fresh = (lo: number, hi: number): boolean => !full && !stale.some((at) => at >= lo && at < hi)
    const { viewport, camera } = input
    const visible = visibleRegion(viewport, camera)
    const old = this.pictures
    this.pictures = runs.map((run, i) => {
      const lo = run.hi
      const hi = runs[i + 1]?.lo ?? this.order.length
      const same = old.findIndex((picture) => picture.lo === lo && picture.hi === hi)
      if (same >= 0 && fresh(lo, hi)) return old.splice(same, 1)[0]
      const picture = { canvas: old.pop()?.canvas ?? document.createElement('canvas'), lo, hi }
      const context = prepare(picture.canvas, viewport, camera)
      if (context) for (const at of this.strokesIn(visible, lo, hi)) this.drawAt(context, at)
      return picture
    })
    // Pictures no run uses: free their pixels.
    for (const { canvas } of old) {
      canvas.width = 0
      canvas.height = 0
    }
  }

  /** The live canvas: each run with its overrides and the picture after it, the changing pen ink, the pen tips. */
  private drawLive(live: HTMLCanvasElement, input: InkPaint, transientHighlighter: boolean, transientPen: boolean): void {
    const runs = this.runs
    if (!runs.length && !input.tips.length && !transientPen) {
      if (this.liveUsed) prepare(live, input.viewport, input.camera)
      this.liveUsed = false
      return
    }
    const context = prepare(live, input.viewport, input.camera)
    if (!context) return
    this.liveUsed = true
    const { overrides, camera } = input
    const transients = (tool: 'pen' | 'highlighter'): void => {
      for (const node of input.transients) if ((node.tool === 'highlighter') === (tool === 'highlighter')) drawInk(context, { node, offset: [node.x, node.y] }, 0)
    }
    const visible = visibleRegion(input.viewport, camera)
    const order = this.order
    runs.forEach((run, r) => {
      for (let i = run.lo; i < run.hi; i++) {
        if (transientHighlighter && i === this.highlighters) transients('highlighter')
        const ink = order[i]
        const override = overrides?.get(ink.node.id)
        if (override?.opacity === 0) continue
        // A moving stroke is drawn wherever it is now: skip only unmoved strokes outside the view.
        if (!override?.matrix) {
          const bounds = this.bounds[i]
          if (!bounds || !regionsIntersect(bounds, visible)) continue
        }
        drawInk(context, ink, 0, override, true)
      }
      if (transientHighlighter && run.hi === this.highlighters) transients('highlighter')
      const picture = this.pictures[r]
      if (picture && picture.hi > picture.lo) {
        context.save()
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.drawImage(picture.canvas, 0, 0)
        context.restore()
      }
    })
    // Changing pen ink goes after all committed pen ink.
    if (transientPen) transients('pen')
    drawTips(context, input.tips, camera.zoom)
  }
}

/**
 * Paint the committed items at once (the snapshot window): selection glow
 * first, then highlighters, then pen ink on top. During live-scene playback,
 * overrides change how nodes show, ghost ink (removed by the scene) shows
 * too, and pen tips go on top.
 */
export function paintItems(
  canvas: HTMLCanvasElement | null,
  inks: readonly PaintInk[],
  viewport: Point,
  camera: Camera,
  selected: ReadonlySet<string> = new Set(),
  playback: PlaybackFrame | null = null,
  ghostInks: readonly PaintInk[] = []
): void {
  if (!canvas) return
  const context = prepare(canvas, viewport, camera)
  if (!context) return
  const visible = visibleRegion(viewport, camera)
  const overrides = playback?.overrides
  const all = ghostInks.length ? [...inks, ...ghostInks] : inks
  const strokes = all.filter((ink) => {
    // A moving stroke is drawn wherever it is now: skip only unmoved strokes outside the view.
    if (overrides?.get(ink.node.id)?.matrix) return true
    const bounds = inkBounds(ink.node, ink.offset)
    return bounds !== null && regionsIntersect(bounds, visible)
  })
  if (selected.size) for (const ink of strokes) if (selected.has(ink.node.id) && !overrides?.has(ink.node.id)) drawGlow(context, ink, camera.zoom)
  for (const ink of strokes) if (ink.node.tool === 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id), true)
  for (const ink of strokes) if (ink.node.tool !== 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id), true)
  drawTips(context, playback?.tips ?? [], camera.zoom)
}

/**
 * The stroke in progress. Each piece of a stroke needs the sample after it,
 * so all but the last piece never change: they go once on the first canvas.
 * The second canvas holds the last piece, and a frame clears only what that
 * piece covered. So a frame costs the new samples, at any length of stroke.
 *
 * The pieces are the curves of drawStroke, so the committed stroke shows the
 * same pixels. A highlighter draws at full alpha in a group with its alpha:
 * the group shows one flat tone, as the one path of a committed highlighter.
 */
export class ActiveInk {
  /** The stroke and the view on the first canvas. */
  private key = ''
  /** The first canvas holds the pieces before this sample. */
  private done = 0
  /** All samples so far have one pressure: one path, as drawStroke draws it. */
  private uniform = true
  /** Samples checked for `uniform`. */
  private checked = 0
  /** What the second canvas covers, in device pixels. */
  private covered: Region | null = null
  private used = false

  paint(group: HTMLElement | null, settled: HTMLCanvasElement | null, tail: HTMLCanvasElement | null, stroke: StrokeItem | null, viewport: Point, camera: Camera): void {
    if (!group || !settled || !tail) return
    if (!stroke) {
      if (!this.used) return
      this.used = false
      this.key = ''
      this.covered = null
      prepare(settled, viewport, camera)
      prepare(tail, viewport, camera)
      group.style.opacity = ''
      return
    }
    const highlighter = stroke.tool === 'highlighter'
    const points = stroke.points
    const uniform = highlighter || this.stillUniform(stroke)
    const dpr = window.devicePixelRatio || 1
    const key = `${stroke.id},${viewport[0]},${viewport[1]},${dpr},${camera.center[0]},${camera.center[1]},${camera.zoom},${uniform}`
    let context: CanvasRenderingContext2D | null
    let last: CanvasRenderingContext2D | null
    if (key !== this.key) {
      context = prepare(settled, viewport, camera)
      last = prepare(tail, viewport, camera)
      this.key = key
      this.done = 0
      this.covered = null
      this.used = true
      group.style.opacity = highlighter ? String(HIGHLIGHTER_ALPHA) : ''
    } else {
      context = settled.getContext('2d')
      last = tail.getContext('2d')
    }
    if (!context || !last) return
    context.strokeStyle = stroke.color
    last.strokeStyle = stroke.color
    last.fillStyle = stroke.color
    // The pieces that the newest sample ended.
    const end = points.length - 1
    const nib = (p: number): number => stroke.width * (highlighter ? 1 : pressureWidth(p))
    if (uniform) {
      if (end >= 2 && this.done < end - 1) {
        context.lineWidth = nib(points[0][2])
        context.beginPath()
        const from = Math.max(1, this.done + 1)
        const at = this.done === 0 ? points[0] : midpoint(points[this.done], points[from])
        context.moveTo(at[0], at[1])
        for (let i = from; i < end; i++) {
          const [x, y] = points[i]
          const [nx, ny] = points[i + 1]
          context.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2)
        }
        context.stroke()
        this.done = end - 1
      }
    } else {
      for (let i = this.done; i < end; i++) {
        const [x, y, p] = points[i]
        const start = i === 0 ? points[0] : midpoint(points[i - 1], points[i])
        const stop = midpoint(points[i], points[i + 1])
        context.lineWidth = nib(p)
        context.beginPath()
        context.moveTo(start[0], start[1])
        context.quadraticCurveTo(x, y, stop[0], stop[1])
        context.stroke()
      }
      this.done = Math.max(this.done, end)
    }
    // The last piece.
    const [tx, ty] = inkOrigin(viewport, camera, dpr)
    const scale = dpr * camera.zoom
    if (this.covered) {
      const { x, y, width, height } = this.covered
      last.save()
      last.setTransform(1, 0, 0, 1, 0, 0)
      last.clearRect(x, y, width, height)
      last.restore()
    }
    const tip = points[end]
    const width = nib(tip[2])
    if (end === 0) {
      last.beginPath()
      last.arc(tip[0], tip[1], width / 2, 0, Math.PI * 2)
      last.fill()
      this.covered = coverOf(tip, tip, width, scale, tx, ty)
      return
    }
    const from = end === 1 && uniform ? points[0] : midpoint(points[end - 1], tip)
    last.lineWidth = width
    last.beginPath()
    last.moveTo(from[0], from[1])
    last.lineTo(tip[0], tip[1])
    last.stroke()
    this.covered = coverOf(from, tip, width, scale, tx, ty)
  }

  /** Samples only come at the end: each is checked once. A stroke that was just begun starts over. */
  private stillUniform(stroke: StrokeItem): boolean {
    const points = stroke.points
    if (points.length < this.checked || !this.key.startsWith(`${stroke.id},`)) {
      this.checked = 0
      this.uniform = true
    }
    for (; this.uniform && this.checked < points.length; this.checked++) if (points[this.checked][2] !== points[0][2]) this.uniform = false
    return this.uniform
  }
}

const midpoint = (a: StrokeItem['points'][number], b: StrokeItem['points'][number]): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/** The device pixels of a line between two board points, with its nib and a margin for the edge. */
function coverOf(a: readonly number[], b: readonly number[], width: number, scale: number, tx: number, ty: number): Region {
  const pad = (width * scale) / 2 + 2
  const x = Math.floor(Math.min(a[0], b[0]) * scale + tx - pad)
  const y = Math.floor(Math.min(a[1], b[1]) * scale + ty - pad)
  return { x, y, width: Math.ceil(Math.abs(a[0] - b[0]) * scale + pad * 2) + 1, height: Math.ceil(Math.abs(a[1] - b[1]) * scale + pad * 2) + 1 }
}

/** A box drawn over an offscreen render, in board coordinates. */
export interface RenderOutline {
  rect: Region
  color: string
}

export interface RegionRender {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

/** The thinnest ink line in an offscreen render, in image pixels. */
const MIN_EXPORT_INK_PX = 1.5

/**
 * Draw the items inside `rect` onto a new canvas at `scale` image pixels per
 * board point: the same stroke code as the board, on `background`, with no dot
 * grid, no selection glow and no UI. Ink never draws thinner than
 * MIN_EXPORT_INK_PX, so thin strokes stay legible at a small scale.
 * Outlines are thin dashed boxes on top (the "changes" view).
 *
 * Content nodes (frames, text, svg, images) are not drawn here yet.
 * Step 3a part 2 replaces this with a pixel capture of the content layer.
 */
export function renderRegion(
  inks: readonly PaintInk[],
  rect: Region,
  scale: number,
  background: string,
  outlines: readonly RenderOutline[] = []
): RegionRender | null {
  const width = Math.max(1, Math.round(rect.width * scale))
  const height = Math.max(1, Math.round(rect.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  context.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const minWidth = MIN_EXPORT_INK_PX / scale
  const strokes = inks.filter((ink) => {
    const bounds = inkBounds(ink.node, ink.offset)
    return bounds !== null && regionsIntersect(bounds, rect)
  })
  for (const ink of strokes) if (ink.node.tool === 'highlighter') drawInk(context, ink, minWidth, undefined, true)
  for (const ink of strokes) if (ink.node.tool !== 'highlighter') drawInk(context, ink, minWidth, undefined, true)

  // Outlines in image pixels, so they stay thin at any scale.
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.lineWidth = 1.5
  context.setLineDash([6, 4])
  for (const outline of outlines) {
    context.strokeStyle = outline.color
    context.strokeRect(
      Math.round((outline.rect.x - rect.x) * scale) + 0.5,
      Math.round((outline.rect.y - rect.y) * scale) + 0.5,
      Math.max(2, Math.round(outline.rect.width * scale)),
      Math.max(2, Math.round(outline.rect.height * scale))
    )
  }
  return { canvas, width, height }
}
