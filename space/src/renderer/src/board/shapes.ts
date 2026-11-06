/**
 * The strokes of a shape (decision B71). A rectangle, an ellipse, an arrow or a line stays an
 * editable item (ShapeNode) and the ink painter draws it: this module turns its fields into ink
 * strokes with the hand of hand.ts (the wobble and taper of the agents' pen ink), seeded by the
 * shape's own seed, and into one fill polygon under them. The strokes are made from the shape's
 * size each time, so a resized shape keeps the size of its wobble.
 *
 * Everything that paints, hits, picks or measures ink takes a shape through the `painted*`
 * functions here, so ink and shapes share one look and one set of rules.
 */

import { mulberry32 } from '@shared/live-scene'
import type { InkPoint, ShapeHeads, ShapeKind, ShapeLine, ShapeNode } from '@shared/board-format'
import { inkLocalBounds, pointInPolygon, strokeHitByCircle, strokeInsidePolygon } from './geometry'
import { humanize } from './hand'
import type { InkNode, PaintedNode, Point, Region } from './types'

/** The wobble of a shape's stroke, as hand.ts humanize takes it (about 1 board point on a long side). */
const JITTER = 0.45
/** A side or a loop shorter than this wobbles less, in proportion (board points). */
const FULL_WOBBLE_LENGTH = 120
/** The pressure of a dashed or dotted line: one even width, so each dash is one path. */
const EVEN_PRESSURE = 0.55
/** An arrowhead's wings turn this far from the shaft (radians). */
const HEAD_ANGLE = 0.5
/** A light fill is the colour at this alpha. */
export const LIGHT_FILL_ALPHA = 0.18
/** At most this many shape geometries are kept for reuse (a move or a restyle makes a new node with the same strokes). */
const MAX_GEOMETRIES = 1024

/** The fields of a shape that its strokes depend on (not its place or its colour). */
interface Geometry {
  /** The lines as they are painted: dashes and dots for a line that is not solid. */
  strokes: InkPoint[][]
  /** The whole lines before dashes: hit tests and picks use them, so a gap is no hole. */
  paths: InkPoint[][]
  /** The outline of a rectangle or an ellipse, for its fill and for a press inside it. */
  outline: Point[] | null
}

/** What the painter and the hit tests use of one shape node. Local coordinates: the node's x, y is 0, 0. */
export interface ShapeLook {
  /** The painted strokes as ink nodes (the node's id, colour and width). */
  strokes: InkNode[]
  /** The whole lines before dashes, as ink nodes. The same array as `strokes` for a solid line. */
  paths: InkNode[]
  /** The fill polygon, or null without a fill. */
  fill: Point[] | null
  /** The bounds of what paints, with the nib, or null when nothing paints. */
  bounds: Region | null
  /** The fill as a path, made at its first paint. */
  fillPath?: Path2D
}

const geometries = new Map<string, Geometry>()
const looks = new WeakMap<ShapeNode, ShapeLook>()

/** How much a line of this length wobbles. */
const jitterFor = (length: number): number => JITTER * Math.min(1, length / FULL_WOBBLE_LENGTH)

const add = (a: Point, b: Point, k = 1): Point => [a[0] + b[0] * k, a[1] + b[1] * k]

/**
 * One side of a rectangle, as a pen draws it: it starts a little before its corner and runs a
 * little past the next one, slightly off the true line.
 */
function side(a: Point, b: Point, width: number, random: () => number): InkPoint[] | null {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (length < 0.5) return null
  const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
  const n: Point = [-u[1], u[0]]
  const over = Math.min(length * 0.08, 2 + width * 0.6)
  const nudge = Math.min(1.6, length * 0.02)
  const start = add(add(a, u, -over * (0.2 + 0.3 * random())), n, (random() - 0.5) * nudge)
  const end = add(add(b, u, over * (0.6 + 0.4 * random())), n, (random() - 0.5) * nudge)
  return humanize([start, end], jitterFor(length), random)
}

/** The ellipse in the box, as `count` points from angle `from` over `turn` radians; `drift` widens it a little as it goes round. */
function ellipsePoints(w: number, h: number, from: number, turn: number, count: number, drift = 0): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= count; i++) {
    const t = i / count
    const angle = from + turn * t
    const k = 1 + drift * t
    out.push([w / 2 + (w / 2) * k * Math.cos(angle), h / 2 + (h / 2) * k * Math.sin(angle)])
  }
  return out
}

/** An arrowhead at `tip`, pointing along `dir` (a unit vector): one stroke over both wings. */
function head(tip: Point, dir: Point, length: number, random: () => number): InkPoint[] {
  const back: Point = [-dir[0], -dir[1]]
  const turn = (angle: number): Point => [back[0] * Math.cos(angle) - back[1] * Math.sin(angle), back[0] * Math.sin(angle) + back[1] * Math.cos(angle)]
  const spread = HEAD_ANGLE * (0.92 + 0.16 * random())
  return humanize([add(tip, turn(spread), length), tip, add(tip, turn(-spread), length)], 0.25, random)
}

/**
 * A line cut into dashes or dots by its length. A closed line has whole periods all round; an open
 * one begins and ends with a dash or a dot. The period stretches a little so that they fit.
 */
function dashed(points: InkPoint[], line: ShapeLine, width: number, closed: boolean): InkPoint[][] {
  if (line === 'solid' || points.length < 2) return [points]
  const even = points.map(([x, y]) => [x, y, EVEN_PRESSURE] as InkPoint)
  const lengths = [0]
  for (let i = 1; i < even.length; i++) lengths.push(lengths[i - 1] + Math.hypot(even[i][0] - even[i - 1][0], even[i][1] - even[i - 1][1]))
  const total = lengths[lengths.length - 1]
  if (total < 1) return [even]
  /** The point at length s along the line. */
  let at = 1
  const pointAt = (s: number): InkPoint => {
    while (at < even.length - 1 && lengths[at] < s) at++
    while (at > 1 && lengths[at - 1] > s) at--
    const span = lengths[at] - lengths[at - 1] || 1
    const k = Math.min(1, Math.max(0, (s - lengths[at - 1]) / span))
    const [ax, ay] = even[at - 1]
    const [bx, by] = even[at]
    return [ax + (bx - ax) * k, ay + (by - ay) * k, EVEN_PRESSURE]
  }
  const out: InkPoint[][] = []
  if (line === 'dotted') {
    const pitch = width * 2.2 + 4
    const count = Math.max(1, Math.round(total / pitch))
    const step = total / count
    for (let i = 0; i <= (closed ? count - 1 : count); i++) out.push([pointAt(i * step)])
    return out
  }
  let dash = width * 3.2 + 6
  let gap = width * 2.4 + 5
  const count = Math.max(1, Math.round(closed ? total / (dash + gap) : (total + gap) / (dash + gap)))
  const scale = (closed ? total : total + gap) / (count * (dash + gap))
  dash *= scale
  gap *= scale
  for (let k = 0; k < count; k++) {
    const from = k * (dash + gap)
    const to = Math.min(total, from + dash)
    const piece: InkPoint[] = [pointAt(from)]
    for (let i = 0; i < even.length; i++) if (lengths[i] > from && lengths[i] < to) piece.push(even[i])
    piece.push(pointAt(to))
    out.push(piece)
  }
  return out
}

/** The strokes and the outline of a shape, from its kind, size, width, line, heads and seed. */
function makeGeometry(shape: ShapeKind, w: number, h: number, width: number, line: ShapeLine, heads: ShapeHeads, seed: number): Geometry {
  const random = mulberry32(seed)
  const strokes: InkPoint[][] = []
  const paths: InkPoint[][] = []
  let outline: Point[] | null = null
  /** A drawn line: its path, and its strokes (dashes when the line is not solid). */
  const put = (points: InkPoint[] | null, closed = false, solid = false): void => {
    if (!points || points.length < 2) return
    paths.push(points)
    strokes.push(...dashed(points, solid ? 'solid' : line, width, closed))
  }
  if (shape === 'rect') {
    const corners: Point[] = [[0, 0], [w, 0], [w, h], [0, h]]
    outline = corners
    if (line === 'solid') for (let i = 0; i < 4; i++) put(side(corners[i], corners[(i + 1) % 4], width, random))
    else if (w >= 0.5 || h >= 0.5) {
      // Dashes and dots run round the corners: one closed line.
      const loop = [...corners, corners[0]]
      put(humanize(loop, jitterFor((w + h) / 2), random), true)
    }
  } else if (shape === 'ellipse') {
    const around = Math.PI * (3 * (w + h) / 2 - Math.sqrt(((3 * w) / 2 + h / 2) * (w / 2 + (3 * h) / 2)))
    outline = ellipsePoints(w, h, 0, Math.PI * 2, 64).slice(0, 64)
    if (around >= 1) {
      const count = Math.max(24, Math.ceil(around / 3))
      const from = random() * Math.PI * 2
      if (line === 'solid') {
        // A pen goes a little past where it began, a little wider than it started.
        const overlap = 0.14 + random() * 0.1
        put(humanize(ellipsePoints(w, h, from, Math.PI * 2 + overlap, count, (random() - 0.5) * 0.04), jitterFor(around / 4), random))
      } else put(humanize(ellipsePoints(w, h, from, Math.PI * 2, count), jitterFor(around / 4), random), true)
    }
  } else {
    const length = Math.hypot(w, h)
    if (length >= 0.5) {
      put(humanize([[0, 0], [w, h]], jitterFor(length), random))
      if (shape === 'arrow' && heads !== 'none') {
        const dir: Point = [w / length, h / length]
        const size = Math.min(length * 0.4, 8 + width * 3.2)
        put(head([w, h], dir, size, random), false, true)
        if (heads === 'both') put(head([0, 0], [-dir[0], -dir[1]], size, random), false, true)
      }
    }
  }
  return { strokes, paths, outline }
}

function geometryOf(node: ShapeNode): Geometry {
  const key = `${node.shape} ${node.w} ${node.h} ${node.width} ${node.line} ${node.heads} ${node.seed}`
  let geometry = geometries.get(key)
  if (geometry) {
    geometries.delete(key)
  } else {
    geometry = makeGeometry(node.shape, node.w, node.h, Math.max(0.5, node.width), node.line, node.heads, node.seed)
    if (geometries.size >= MAX_GEOMETRIES) geometries.delete(geometries.keys().next().value as string)
  }
  geometries.set(key, geometry)
  return geometry
}

/** A shape's strokes, fill and bounds. Cached per node object; nodes with the same strokes share their points, so the painter keeps their paths. */
export function shapeLook(node: ShapeNode): ShapeLook {
  let look = looks.get(node)
  if (look) return look
  const geometry = geometryOf(node)
  const stroke = (points: InkPoint[]): InkNode => ({ id: node.id, kind: 'ink', x: 0, y: 0, z: 0, author: node.author, seq: 0, tool: 'pen', color: node.color, width: node.width, points })
  const strokes = geometry.strokes.map(stroke)
  // A solid line paints its whole lines: they are its strokes.
  const paths = node.line === 'solid' ? strokes : geometry.paths.map(stroke)
  const fill = node.fill !== 'none' && geometry.outline ? geometry.outline : null
  let bounds: Region | null = null
  const grow = (region: Region | null): void => {
    if (!region) return
    if (!bounds) {
      bounds = { ...region }
      return
    }
    const right = Math.max(bounds.x + bounds.width, region.x + region.width)
    const bottom = Math.max(bounds.y + bounds.height, region.y + region.height)
    bounds.x = Math.min(bounds.x, region.x)
    bounds.y = Math.min(bounds.y, region.y)
    bounds.width = right - bounds.x
    bounds.height = bottom - bounds.y
  }
  for (const each of strokes) grow(inkLocalBounds(each))
  if (fill) grow(polygonRegion(fill))
  look = { strokes, paths, fill, bounds }
  looks.set(node, look)
  return look
}

function polygonRegion(polygon: readonly Point[]): Region {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// ---------- Ink and shapes alike ----------

/** A marker stroke: it paints translucent, under the pen ink and the shapes. */
export function isMarker(node: PaintedNode): boolean {
  return node.kind === 'ink' && node.tool === 'highlighter'
}

/** What paints of a painted node, in its local coordinates, with the nib; null when nothing paints. */
export function paintedLocalBounds(node: PaintedNode): Region | null {
  return node.kind === 'ink' ? inkLocalBounds(node) : shapeLook(node).bounds
}

/** What paints of a painted node, at its world offset (the world place of its local 0, 0). */
export function paintedBounds(node: PaintedNode, offset: Point): Region | null {
  const local = paintedLocalBounds(node)
  return local ? { ...local, x: local.x + offset[0], y: local.y + offset[1] } : null
}

/** True when a circle of `radius` around the world `point` touches the node's strokes, or lies inside a filled shape. */
export function paintedHitByCircle(node: PaintedNode, offset: Point, point: Point, radius: number): boolean {
  if (node.kind === 'ink') return strokeHitByCircle(node, offset, point, radius)
  const look = shapeLook(node)
  if (look.fill && pointInPolygon([point[0] - offset[0], point[1] - offset[1]], look.fill)) return true
  return look.paths.some((path) => strokeHitByCircle(path, offset, point, radius))
}

/** The length of a shape's lines (board points): a scene draws a shape over its share of the drawing by it. */
export function shapeLength(node: ShapeNode): number {
  let total = 0
  for (const { points } of shapeLook(node).paths) for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return total
}

/** The lasso and box rule of ink for a painted node: most of its length lies inside the polygon. */
export function paintedInsidePolygon(node: PaintedNode, offset: Point, polygon: readonly Point[]): boolean {
  if (node.kind === 'ink') return strokeInsidePolygon(node, offset, polygon)
  const paths = shapeLook(node).paths
  if (paths.length === 1) return strokeInsidePolygon(paths[0], offset, polygon)
  // All the lines as one, so each counts by its length.
  return paths.length > 0 && strokeInsidePolygon({ ...paths[0], points: paths.flatMap((path) => path.points) }, offset, polygon)
}

// ---------- Making and changing shapes ----------

/** The style fields a new shape takes. */
export interface ShapeStyle {
  color: string
  width: number
  fill: ShapeNode['fill']
  line: ShapeLine
  heads: ShapeHeads
}

const r1 = (value: number): number => {
  const out = Math.round(value * 10) / 10
  return Object.is(out, -0) ? 0 : out
}

/** A new learner shape at a board point, with no size yet; its drag gives it one (shapeTo). */
export function newShape(id: string, shape: ShapeKind, at: Point, style: ShapeStyle, z: number): ShapeNode {
  const seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  return { id, kind: 'shape', shape, x: r1(at[0]), y: r1(at[1]), z, author: 'learner', seq: 0, w: 0, h: 0, color: style.color, width: style.width, fill: style.fill, line: style.line, heads: style.heads, seed }
}

/** Shift turns a line or an arrow in steps of this many degrees. */
export const ANGLE_SNAP = 15

/** The vector `v` turned to the nearest ANGLE_SNAP step, with its length. */
function snapAngle([dx, dy]: Point): Point {
  const length = Math.hypot(dx, dy)
  const step = (ANGLE_SNAP * Math.PI) / 180
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return [length * Math.cos(angle), length * Math.sin(angle)]
}

/**
 * A shape drawn from the board point `from` to `to` (both in the shape's parent coordinates).
 * A box drawn in any direction keeps its top-left in x, y; `constrain` (Shift) makes a square or a
 * circle, or turns a line in ANGLE_SNAP steps. Values are on the board file's 0.1 grid, so a saved
 * shape reloads with the same strokes.
 */
export function shapeTo(node: ShapeNode, from: Point, to: Point, constrain: boolean): ShapeNode {
  let dx = to[0] - from[0]
  let dy = to[1] - from[1]
  if (node.shape === 'arrow' || node.shape === 'line') {
    if (constrain) [dx, dy] = snapAngle([dx, dy])
    return { ...node, x: r1(from[0]), y: r1(from[1]), w: r1(dx), h: r1(dy) }
  }
  if (constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    dx = (dx < 0 ? -1 : 1) * size
    dy = (dy < 0 ? -1 : 1) * size
  }
  // The size is rounded once, so a square stays square on the 0.1 grid.
  const w = r1(Math.abs(dx))
  const h = r1(Math.abs(dy))
  return { ...node, x: r1(r1(from[0]) - (dx < 0 ? w : 0)), y: r1(r1(from[1]) - (dy < 0 ? h : 0)), w, h }
}

/** True for the shapes that are a line from a start to an end: they have endpoint handles, not a box. */
export function hasEnds(node: ShapeNode): boolean {
  return node.shape === 'arrow' || node.shape === 'line'
}

/** An arrow or a line with its start or its end moved by `delta` (board points); `constrain` turns it in ANGLE_SNAP steps about the other end. */
export function moveEnd(node: ShapeNode, end: 'start' | 'end', delta: Point, constrain: boolean): ShapeNode {
  if (end === 'end') {
    let vector: Point = [node.w + delta[0], node.h + delta[1]]
    if (constrain) vector = snapAngle(vector)
    return { ...node, w: r1(vector[0]), h: r1(vector[1]) }
  }
  // The end stays: the start moves, and the vector from it to the end follows.
  const endX = node.x + node.w
  const endY = node.y + node.h
  let vector: Point = [node.w - delta[0], node.h - delta[1]]
  if (constrain) vector = snapAngle(vector)
  return { ...node, x: r1(endX - vector[0]), y: r1(endY - vector[1]), w: r1(vector[0]), h: r1(vector[1]) }
}

/** A rectangle or an ellipse in a new box; `box` is in the shape's world coordinates, `origin` the world place of its parent's 0, 0. */
export function shapeInBox(node: ShapeNode, box: Region, origin: Point): ShapeNode {
  return { ...node, x: r1(box.x - origin[0]), y: r1(box.y - origin[1]), w: r1(box.width), h: r1(box.height) }
}
