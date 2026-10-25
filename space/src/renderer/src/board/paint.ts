import { inkBounds, pressureWidth, regionsIntersect } from './geometry'
import { revealPoints, type NodeOverride, type PlaybackFrame } from './playback'
import type { Camera, InkNode, Point, Region } from './types'

type StrokeItem = InkNode

/** An ink node with its world offset (the world position of its local 0,0). */
export interface PaintInk {
  node: InkNode
  offset: Point
}

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

/** Draw one ink node at its world offset; a playback override moves, fades, recolours or partly draws it. */
function drawInk(context: CanvasRenderingContext2D, ink: PaintInk, minWidth = 0, override?: NodeOverride): void {
  context.save()
  if (override?.matrix) context.transform(...override.matrix)
  context.translate(ink.offset[0], ink.offset[1])
  if (override && (override.reveal !== undefined || override.color !== undefined)) {
    const points = override.reveal === undefined ? ink.node.points : revealPoints(ink.node.points, override.reveal)
    drawStroke(context, { ...ink.node, points, color: override.color ?? ink.node.color }, minWidth, override.opacity ?? 1)
  } else drawStroke(context, ink.node, minWidth, override?.opacity ?? 1)
  context.restore()
}

/** `minWidth`: the thinnest line to draw, in board points (offscreen export only). `alpha` multiplies the ink's own. */
function drawStroke(context: CanvasRenderingContext2D, stroke: StrokeItem, minWidth = 0, alpha = 1): void {
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
  const uniform = highlighter || points.every((point) => point[2] === points[0][2])
  if (uniform) {
    context.lineWidth = Math.max(minWidth, stroke.width * (highlighter ? 1 : pressureWidth(points[0][2])))
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
    context.lineWidth = Math.max(minWidth, stroke.width * pressureWidth(p))
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

/**
 * Paint the committed items: selection glow first, then highlighters, then
 * pen ink on top. During live-scene playback, overrides change how nodes
 * show, ghost ink (removed by the scene) shows too, and pen tips go on top.
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
  for (const ink of strokes) if (ink.node.tool === 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id))
  for (const ink of strokes) if (ink.node.tool !== 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id))
  for (const tip of playback?.tips ?? []) drawTip(context, tip.point, tip.color, tip.size, camera.zoom)
}

/** Paint the stroke in progress on the overlay layer. */
export function paintActive(canvas: HTMLCanvasElement | null, stroke: StrokeItem | null, viewport: Point, camera: Camera): void {
  if (!canvas) return
  const context = prepare(canvas, viewport, camera)
  if (context && stroke) drawStroke(context, stroke)
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
  for (const ink of strokes) if (ink.node.tool === 'highlighter') drawInk(context, ink, minWidth)
  for (const ink of strokes) if (ink.node.tool !== 'highlighter') drawInk(context, ink, minWidth)

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
