import { isStroke } from '@shared/board-format'
import { pressureWidth, regionsIntersect, strokeBounds } from './geometry'
import type { BoardItem, Camera, Point, Region, StrokeItem } from './types'

/** Highlighter ink is translucent and sits under pen ink. */
export const HIGHLIGHTER_ALPHA = 0.55

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
  context.setTransform(
    dpr * camera.zoom,
    0,
    0,
    dpr * camera.zoom,
    dpr * (width / 2 - camera.center[0] * camera.zoom),
    dpr * (height / 2 - camera.center[1] * camera.zoom)
  )
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
function tracePath(context: CanvasRenderingContext2D, points: StrokeItem['points']): void {
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

function drawStroke(context: CanvasRenderingContext2D, stroke: StrokeItem): void {
  const points = stroke.points
  if (!points.length) return
  context.strokeStyle = stroke.color
  context.fillStyle = stroke.color
  const highlighter = stroke.tool === 'highlighter'
  context.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1

  if (points.length === 1) {
    const [x, y, p] = points[0]
    const radius = (stroke.width * (highlighter ? 1 : pressureWidth(p))) / 2
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1
    return
  }

  // One path for highlighters and constant-pressure ink: a translucent path
  // must not darken where its own segments overlap.
  const uniform = highlighter || points.every((point) => point[2] === points[0][2])
  if (uniform) {
    context.lineWidth = stroke.width * (highlighter ? 1 : pressureWidth(points[0][2]))
    context.beginPath()
    tracePath(context, points)
    context.stroke()
    context.globalAlpha = 1
    return
  }

  // Pressure ink: one curve piece per sample, each with its own width.
  // Piece i runs from the midpoint before sample i to the midpoint after it.
  const mid = (a: StrokeItem['points'][number], b: StrokeItem['points'][number]): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const last = points.length - 1
  for (let i = 0; i <= last; i++) {
    const [x, y, p] = points[i]
    const start: Point = i === 0 ? [x, y] : mid(points[i - 1], points[i])
    const end: Point = i === last ? [x, y] : mid(points[i], points[i + 1])
    context.lineWidth = stroke.width * pressureWidth(p)
    context.beginPath()
    context.moveTo(start[0], start[1])
    context.quadraticCurveTo(x, y, end[0], end[1])
    context.stroke()
  }
  context.globalAlpha = 1
}

/** The selection glow colour (the --accent token). */
const SELECTION_GLOW = '#6e8bff'

/** A soft accent band under a selected stroke, a few screen pixels wider than its ink. */
function drawGlow(context: CanvasRenderingContext2D, stroke: StrokeItem, zoom: number): void {
  const points = stroke.points
  if (!points.length) return
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
}

/**
 * Paint the committed items: selection glow first, then highlighters, then
 * pen ink on top.
 */
export function paintItems(
  canvas: HTMLCanvasElement | null,
  items: readonly BoardItem[],
  viewport: Point,
  camera: Camera,
  selected: ReadonlySet<string> = new Set()
): void {
  if (!canvas) return
  const context = prepare(canvas, viewport, camera)
  if (!context) return
  const visible = visibleRegion(viewport, camera)
  const strokes = items.filter(isStroke).filter((stroke) => {
    const bounds = strokeBounds(stroke)
    return bounds !== null && regionsIntersect(bounds, visible)
  })
  if (selected.size) for (const stroke of strokes) if (selected.has(stroke.id)) drawGlow(context, stroke, camera.zoom)
  for (const stroke of strokes) if (stroke.tool === 'highlighter') drawStroke(context, stroke)
  for (const stroke of strokes) if (stroke.tool !== 'highlighter') drawStroke(context, stroke)
}

/** Paint the stroke in progress on the overlay layer. */
export function paintActive(canvas: HTMLCanvasElement | null, stroke: StrokeItem | null, viewport: Point, camera: Camera): void {
  if (!canvas) return
  const context = prepare(canvas, viewport, camera)
  if (context && stroke) drawStroke(context, stroke)
}
