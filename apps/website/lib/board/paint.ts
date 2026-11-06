// Copied from space/src/renderer/src/board/paint.ts (tracePath, writePiece, piecesOf, strokePieces, the stroke shape
// cache, drawStroke), geometry.ts (pressureWidth), playback.ts (cumulative, revealPoints) and live/compile.ts (LIFT,
// ranges). Changed only the imports and the types: a stroke is { points, color, width, tool }.
import type { InkPoint } from './hand'

type StrokeItem = { points: InkPoint[]; color: string; width: number; tool?: 'pen' | 'highlighter' }

/** A canvas or a tile: stroke code draws on both. */
type InkContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Highlighter ink is translucent and sits under pen ink. */
export const HIGHLIGHTER_ALPHA = 0.55

/**
 * The drawn width factor for a pressure value. Mouse input (0.5) draws the
 * nominal width; a light pen touch draws thinner, a hard one thicker.
 */
export function pressureWidth(pressure: number): number {
  return 0.35 + 1.3 * Math.min(1, Math.max(0, pressure))
}


/** A smooth path through the points: quadratic curves between segment midpoints. */
export function tracePath(context: InkContext | Path2D, points: StrokeItem['points']): void {
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
 * `minWidth`: the thinnest line to draw, in board points (offscreen export only). `alpha` multiplies the ink's own.
 * `whole`: the points of a committed node, which never change, so their shape is kept. The stroke's points are these, or the start of them with one more point at the end (revealPoints).
 */
export function drawStroke(context: InkContext, stroke: StrokeItem, minWidth = 0, alpha = 1, whole?: StrokeItem['points']): void {
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


// ---------- From playback.ts ----------


const lengthCache = new WeakMap<object, Float64Array>()

/** Cumulative arc length at each point. */
function cumulative(points: ReadonlyArray<readonly [number, number, number]>): Float64Array {
  let cached = lengthCache.get(points)
  if (cached) return cached
  cached = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) cached[i] = cached[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  lengthCache.set(points, cached)
  return cached
}

/** The first `share` (0..1) of a stroke's points, by length, ending in an interpolated point. */
export function revealPoints<P extends readonly [number, number, number]>(points: readonly P[], share: number): P[] {
  if (share >= 1 || points.length < 2) return points as P[]
  if (share <= 0) return []
  const lengths = cumulative(points)
  const target = lengths[lengths.length - 1] * share
  const out: P[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (lengths[i] <= target) {
      out.push(points[i])
      continue
    }
    const span = lengths[i] - lengths[i - 1] || 1
    const k = (target - lengths[i - 1]) / span
    const a = points[i - 1]
    const b = points[i]
    out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] as unknown as P)
    break
  }
  return out
}

// ---------- From live/compile.ts ----------

/** Pen lift between strokes of one ink object, in board points of drawing time. */
export const LIFT = 9


/** Ink ranges: each stroke's share of the object's drawing, by length, with a short lift between strokes. */
export function ranges(lengths: number[]): Array<[number, number]> {
  const total = lengths.reduce((sum, length) => sum + length, 0) + LIFT * Math.max(0, lengths.length - 1) || 1
  let at = 0
  return lengths.map((length, i) => {
    const range: [number, number] = [at / total, (at + length) / total]
    at += length + (i < lengths.length - 1 ? LIFT : 0)
    return range
  })
}
