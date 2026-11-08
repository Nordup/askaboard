/**
 * The strokes of a shape (decision B71). A rectangle, an ellipse, an arrow or a line stays an
 * editable item (ShapeNode) and the ink painter draws it: this module turns its fields into ink
 * strokes made exactly as an agent's pen shape is (docs/learning-space/agent-ink.md): the outline of
 * shared/pen-shapes.ts, flattened by flattenPath, sampled and humanized by hand.ts penInk with the
 * shape's own seed, so the line has the pen's wobble and its pressure taper at both ends. A fill is
 * one polygon under the strokes, on the outline without the wobble. The strokes are made from the
 * shape's size each time, so a resized shape keeps the size of its wobble.
 *
 * Everything that paints, hits, picks or measures ink takes a shape through the `painted*`
 * functions here, so ink and shapes share one look and one set of rules.
 */

import { mulberry32 } from '@shared/live-scene'
import { flattenPath } from '@shared/path-geometry'
import { arrowHead, arrowWings, ellipseSegments, rectSegments } from '@shared/pen-shapes'
import { MAX_SHAPE_EXTENT, type InkPoint, type ShapeHeads, type ShapeKind, type ShapeLine, type ShapeNode } from '@shared/board-format'
import { inkLocalBounds, pointInPolygon, polygonBounds, strokeHitByCircle, strokeInsidePolygon } from './geometry'
import { penInk } from './hand'
import type { InkNode, PaintedNode, Point, Region } from './types'

/**
 * A rectangle's corner radius: this share of its shorter side, at most CORNER_RADIUS board points.
 * A scene's rect() has square corners unless it gives a radius (live-prelude.js rect), so this is the
 * learner's own choice, not an agent default.
 */
const CORNER_SHARE = 0.2
const CORNER_RADIUS = 12
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

/**
 * A line cut into dashes or dots by its length. A closed line has whole periods all round; an open
 * one begins and ends with a dash or a dot. The period stretches a little so that they fit. Each dash
 * and dot keeps the pressure of the line where it lies, so the pen's taper shows through the gaps.
 */
function dashed(points: InkPoint[], line: ShapeLine, width: number, closed: boolean): InkPoint[][] {
  if (line === 'solid' || points.length < 2) return [points]
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
  const total = lengths[lengths.length - 1]
  if (total < 1) return [points]
  /** The point at length s along the line. */
  let at = 1
  const pointAt = (s: number): InkPoint => {
    while (at < points.length - 1 && lengths[at] < s) at++
    while (at > 1 && lengths[at - 1] > s) at--
    const span = lengths[at] - lengths[at - 1] || 1
    const k = Math.min(1, Math.max(0, (s - lengths[at - 1]) / span))
    const [ax, ay, ap] = points[at - 1]
    const [bx, by, bp] = points[at]
    return [ax + (bx - ax) * k, ay + (by - ay) * k, ap + (bp - ap) * k]
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
    for (let i = 0; i < points.length; i++) if (lengths[i] > from && lengths[i] < to) piece.push(points[i])
    piece.push(pointAt(to))
    out.push(piece)
  }
  return out
}

/**
 * The strokes and the outline of a shape, from its kind, size, width, line, heads and seed: the
 * outline as the scene library builds rect, ellipse, line and arrow (shared/pen-shapes.ts), drawn
 * with the agents' pen (hand.ts penInk) and the shape's seed.
 */
function makeGeometry(shape: ShapeKind, w: number, h: number, width: number, line: ShapeLine, heads: ShapeHeads, seed: number): Geometry {
  const random = mulberry32(seed)
  const strokes: InkPoint[][] = []
  const paths: InkPoint[][] = []
  let outline: Point[] | null = null
  /** A drawn line: its path, and its strokes (dashes when the line is not solid; an arrowhead is always solid). */
  const put = (points: InkPoint[] | undefined, closed: boolean, solid = false): void => {
    if (!points || points.length < 2) return
    paths.push(points)
    strokes.push(...dashed(points, solid ? 'solid' : line, width, closed))
  }
  if (shape === 'rect' || shape === 'ellipse') {
    // A rectangle starts at (r, 0) on its top side, an ellipse at its left; both close where they began (Z).
    const segments = shape === 'rect' ? rectSegments(0, 0, w, h, Math.min(CORNER_RADIUS, CORNER_SHARE * Math.min(w, h))) : ellipseSegments(w / 2, h / 2, w / 2, h / 2)
    const lines = flattenPath(segments, 'ink')
    outline = lines.length ? (lines[0] as Point[]) : null
    for (const points of penInk(lines, random)) put(points, true)
  } else {
    const length = Math.hypot(w, h)
    if (length >= 0.5) {
      if (shape === 'arrow' && heads !== 'none') {
        // As a scene's arrow(): the shaft, then the head from one wing over the tip to the other, sampled as one path.
        const size = arrowHead(length, width)
        const [a, b] = arrowWings(0, 0, w, h, size)
        // The head is the last stroke; a shaft much shorter than the sampling step gives no stroke of its own.
        const runs = penInk([[[0, 0], [w, h]], [a, [w, h], b]], random)
        const tip = runs.pop()
        put(runs[0], false)
        put(tip, false, true)
        if (heads === 'both') {
          const [c, d] = arrowWings(w, h, 0, 0, size)
          put(penInk([[c, [0, 0], d]], random)[0], false, true)
        }
      } else put(penInk([[[0, 0], [w, h]]], random)[0], false)
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
  if (fill) grow(polygonBounds(fill))
  look = { strokes, paths, fill, bounds }
  looks.set(node, look)
  return look
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

/** A size or a vector component on the 0.1 grid, within MAX_SHAPE_EXTENT, so the board file keeps the shape. */
const extent = (value: number): number => r1(Math.max(-MAX_SHAPE_EXTENT, Math.min(MAX_SHAPE_EXTENT, value)))
/** A side of a rectangle or an ellipse: as extent, and never negative (the board file refuses a negative side). */
const boxSide = (value: number): number => extent(Math.max(0, value))

/**
 * True when a drawn shape is large enough to keep: a rectangle or an ellipse needs both sides of at
 * least `min`, a line or an arrow a length of at least `min` (board points). A smaller one paints as
 * a doubled line or a dot, so a drag that draws it makes nothing.
 */
export function shapeHasSize(node: ShapeNode, min: number): boolean {
  return hasEnds(node) ? Math.hypot(node.w, node.h) >= min : Math.min(node.w, node.h) >= min
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
    return { ...node, x: r1(from[0]), y: r1(from[1]), w: extent(dx), h: extent(dy) }
  }
  if (constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    dx = (dx < 0 ? -1 : 1) * size
    dy = (dy < 0 ? -1 : 1) * size
  }
  // The size is rounded once, so a square stays square on the 0.1 grid.
  const w = boxSide(Math.abs(dx))
  const h = boxSide(Math.abs(dy))
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
    return { ...node, w: extent(vector[0]), h: extent(vector[1]) }
  }
  // The end stays: the start moves, and the vector from it to the end follows.
  const endX = node.x + node.w
  const endY = node.y + node.h
  let vector: Point = [node.w - delta[0], node.h - delta[1]]
  if (constrain) vector = snapAngle(vector)
  vector = [extent(vector[0]), extent(vector[1])]
  return { ...node, x: r1(endX - vector[0]), y: r1(endY - vector[1]), w: r1(vector[0]), h: r1(vector[1]) }
}

/** A rectangle or an ellipse in a new box; `box` is in the shape's world coordinates, `origin` the world place of its parent's 0, 0. */
export function shapeInBox(node: ShapeNode, box: Region, origin: Point): ShapeNode {
  return { ...node, x: r1(box.x - origin[0]), y: r1(box.y - origin[1]), w: boxSide(box.width), h: boxSide(box.height) }
}
