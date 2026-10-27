import type { Camera, InkNode, Point, Region } from './types'

/**
 * Camera maths and ink geometry. Ink points are relative to the node: every
 * ink function takes the ink's world `offset` (the world position of local
 * point 0,0: the parent origin plus the node's x, y).
 */

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

const boundsCache = new WeakMap<InkNode, Region>()

/** Ink bounds in the node's local coordinates, including the drawn nib radius. Cached per node object. */
export function inkLocalBounds(stroke: InkNode): Region | null {
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

/** Ink bounds in world coordinates. */
export function inkBounds(stroke: InkNode, offset: Point): Region | null {
  const local = inkLocalBounds(stroke)
  return local ? { ...local, x: local.x + offset[0], y: local.y + offset[1] } : null
}

export function regionsIntersect(a: Region, b: Region): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

export function regionContains(region: Region, point: Point, pad = 0): boolean {
  return (
    point[0] >= region.x - pad &&
    point[0] <= region.x + region.width + pad &&
    point[1] >= region.y - pad &&
    point[1] <= region.y + region.height + pad
  )
}

/** The share (0..1) of `inner`'s area that lies inside `outer`. */
export function overlapShare(inner: Region, outer: Region): number {
  const width = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x)
  const height = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y)
  if (width <= 0 || height <= 0) return 0
  const area = Math.max(1e-6, inner.width) * Math.max(1e-6, inner.height)
  return Math.min(1, (width * height) / area)
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
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

/**
 * Points along the stroke, at most `step` apart, so a long straight segment
 * (two samples) counts by its length and not by its two end points.
 */
function densePoints(stroke: InkNode, step: number, cap = 600): Point[] {
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

function polygonBounds(polygon: readonly Point[]): Region {
  const xs = polygon.map((point) => point[0])
  const ys = polygon.map((point) => point[1])
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/**
 * Lasso rule for ink: selected when at least `share` of its length lies
 * inside the polygon (world coordinates).
 */
export function strokeInsidePolygon(stroke: InkNode, offset: Point, polygon: readonly Point[], share = 0.6): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false
  const bounds = inkBounds(stroke, offset)
  if (bounds && !regionsIntersect(bounds, polygonBounds(polygon))) return false
  const samples = densePoints(stroke, 4)
  let inside = 0
  for (const [x, y] of samples) if (pointInPolygon([x + offset[0], y + offset[1]], polygon)) inside++
  return inside / samples.length >= share
}

/** Lasso rule for boxes: selected when at least `share` of the box area lies inside the polygon. */
export function regionInsidePolygon(region: Region, polygon: readonly Point[], share = 0.6): boolean {
  if (polygon.length < 3) return false
  if (!regionsIntersect(region, polygonBounds(polygon))) return false
  const steps = 10
  let inside = 0
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const point: Point = [region.x + (region.width * (i + 0.5)) / steps, region.y + (region.height * (j + 0.5)) / steps]
      if (pointInPolygon(point, polygon)) inside++
    }
  }
  return inside / (steps * steps) >= share
}

/** True when a circle of `radius` around the world `point` touches the drawn stroke. */
export function strokeHitByCircle(stroke: InkNode, offset: Point, point: Point, radius: number): boolean {
  const reach = radius + stroke.width / 2
  const local: Point = [point[0] - offset[0], point[1] - offset[1]]
  const bounds = inkLocalBounds(stroke)
  if (bounds && !regionsIntersect(bounds, { x: local[0] - reach, y: local[1] - reach, width: reach * 2, height: reach * 2 })) return false
  const points = stroke.points
  for (let i = 0; i < points.length; i++) {
    const current: Point = [points[i][0], points[i][1]]
    if (Math.hypot(current[0] - local[0], current[1] - local[1]) <= reach) return true
    if (i > 0 && distanceToSegment(local, [points[i - 1][0], points[i - 1][1]], current) <= reach) return true
  }
  return false
}
