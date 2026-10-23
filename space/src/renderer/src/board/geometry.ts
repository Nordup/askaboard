import { isStroke } from '@shared/board-format'
import type { BoardItem, Camera, Point, Region, StrokeItem } from './types'

/** Ported from web/src/board/geometry.ts (the ink parts only). */

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(value) ? value : 1))
}

/** Board coordinate represented by a viewport point. */
export function screenToBoard(point: Point, size: Point, camera: Camera): Point {
  return [camera.center[0] + (point[0] - size[0] / 2) / camera.zoom, camera.center[1] + (point[1] - size[1] / 2) / camera.zoom]
}

/** Screen point occupied by a board coordinate. */
export function boardToScreen(point: Point, size: Point, camera: Camera): Point {
  return [(point[0] - camera.center[0]) * camera.zoom + size[0] / 2, (point[1] - camera.center[1]) * camera.zoom + size[1] / 2]
}

/** Keep the board point beneath the cursor fixed while zooming. */
export function zoomAt(camera: Camera, screenPoint: Point, size: Point, zoom: number): Camera {
  const anchor = screenToBoard(screenPoint, size, camera)
  const nextZoom = clampZoom(zoom)
  return {
    zoom: nextZoom,
    center: [anchor[0] - (screenPoint[0] - size[0] / 2) / nextZoom, anchor[1] - (screenPoint[1] - size[1] / 2) / nextZoom]
  }
}

/**
 * The drawn width factor for a pressure value. Mouse input (0.5) draws the
 * nominal width; a light pen touch draws thinner, a hard one thicker.
 */
export function pressureWidth(pressure: number): number {
  return 0.35 + 1.3 * Math.min(1, Math.max(0, pressure))
}

const boundsCache = new WeakMap<StrokeItem, Region>()

/** Stroke bounds including the drawn nib radius. Cached per stroke object. */
export function strokeBounds(stroke: StrokeItem): Region | null {
  if (!stroke.points.length) return null
  const cached = boundsCache.get(stroke)
  if (cached) return cached
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxPressure = 0
  for (const [x, y, p] of stroke.points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (p > maxPressure) maxPressure = p
  }
  const factor = stroke.tool === 'highlighter' ? 1 : pressureWidth(maxPressure)
  const pad = (stroke.width * factor) / 2
  const region = { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
  boundsCache.set(stroke, region)
  return region
}

export function regionsIntersect(a: Region, b: Region): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const on = (p: Point, q: Point, r: Point): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1])
  const c1 = cross(a, b, c)
  const c2 = cross(a, b, d)
  const c3 = cross(c, d, a)
  const c4 = cross(c, d, b)
  if (
    (c1 === 0 && on(a, b, c)) ||
    (c2 === 0 && on(a, b, d)) ||
    (c3 === 0 && on(c, d, a)) ||
    (c4 === 0 && on(c, d, b)) ||
    (c1 > 0 !== c2 > 0 && c3 > 0 !== c4 > 0)
  )
    return 0
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b))
}

/** Whole-stroke lasso hit test; the tolerance includes the drawn nib radius. */
export function strokeIntersectsPolygon(stroke: StrokeItem, polygon: Point[]): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false
  const tolerance = Math.max(0, stroke.width / 2)
  const points = stroke.points.map(([x, y]) => [x, y] as Point)
  if (points.some((point) => pointInPolygon(point, polygon))) return true
  const strokeSegments: [Point, Point][] =
    points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((point, i) => [points[i], point])
  const lassoSegments: [Point, Point][] = polygon.map((point, i) => [point, polygon[(i + 1) % polygon.length]])
  return strokeSegments.some(([a, b]) => lassoSegments.some(([c, d]) => segmentDistance(a, b, c, d) <= tolerance))
}

/**
 * Points along the stroke, at most `step` apart, so a long straight segment
 * (two samples) counts by its length and not by its two end points.
 */
function densePoints(stroke: StrokeItem, step: number, cap = 600): Point[] {
  const points = stroke.points
  if (points.length === 0) return []
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  const spacing = Math.max(step, length / cap)
  const out: Point[] = [[points[0][0], points[0][1]]]
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const segments = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing))
    for (let k = 1; k <= segments; k++) out.push([ax + ((bx - ax) * k) / segments, ay + ((by - ay) * k) / segments])
  }
  return out
}

/**
 * Lasso rule: a stroke is selected when at least `share` of its length lies
 * inside the polygon. Both are in board coordinates.
 */
export function strokeInsidePolygon(stroke: StrokeItem, polygon: Point[], share = 0.6): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false
  const xs = polygon.map((point) => point[0])
  const ys = polygon.map((point) => point[1])
  const lasso: Region = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  const bounds = strokeBounds(stroke)
  if (bounds && !regionsIntersect(bounds, lasso)) return false
  const samples = densePoints(stroke, 4)
  let inside = 0
  for (const point of samples) if (pointInPolygon(point, polygon)) inside++
  return inside / samples.length >= share
}

/** The topmost stroke under a point: pen ink above highlighters, later above earlier. */
export function topStrokeAt(items: readonly BoardItem[], point: Point, radius: number): StrokeItem | null {
  const strokes = items.filter(isStroke)
  for (const tool of ['pen', 'highlighter'] as const) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i]
      if (stroke.tool === tool && strokeHitByCircle(stroke, point, radius)) return stroke
    }
  }
  return null
}

/** True when a circle of `radius` around `point` touches the drawn stroke. */
export function strokeHitByCircle(stroke: StrokeItem, point: Point, radius: number): boolean {
  const reach = radius + stroke.width / 2
  const bounds = strokeBounds(stroke)
  if (bounds && !regionsIntersect(bounds, { x: point[0] - reach, y: point[1] - reach, width: reach * 2, height: reach * 2 })) return false
  const points = stroke.points
  for (let i = 0; i < points.length; i++) {
    const current: Point = [points[i][0], points[i][1]]
    if (Math.hypot(current[0] - point[0], current[1] - point[1]) <= reach) return true
    if (i > 0 && distanceToSegment(point, [points[i - 1][0], points[i - 1][1]], current) <= reach) return true
  }
  return false
}

/** Shift the selected strokes. Unselected items keep their identity. */
export function translateItems(items: BoardItem[], ids: ReadonlySet<string>, delta: Point): BoardItem[] {
  if (!ids.size || (!delta[0] && !delta[1])) return items
  return items.map((item) =>
    isStroke(item) && ids.has(item.id)
      ? { ...item, points: item.points.map(([x, y, p]) => [x + delta[0], y + delta[1], p] as StrokeItem['points'][number]) }
      : item
  )
}

export function unionRegions(regions: Array<Region | null>): Region | null {
  const valid = regions.filter(
    (r): r is Region =>
      !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width >= 0 && r.height >= 0
  )
  if (!valid.length) return null
  const x = Math.min(...valid.map((r) => r.x))
  const y = Math.min(...valid.map((r) => r.y))
  const right = Math.max(...valid.map((r) => r.x + r.width))
  const bottom = Math.max(...valid.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** Bounds of the selected strokes. */
export function selectionBounds(items: BoardItem[], ids: readonly string[]): Region | null {
  const selected = new Set(ids)
  return unionRegions(items.filter((item): item is StrokeItem => isStroke(item) && selected.has(item.id)).map(strokeBounds))
}
