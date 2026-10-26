import { inkBounds, pressureWidth, regionsIntersect } from './geometry'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackTip } from './playback'
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
 * still costs nothing per frame. They are drawn again only when the view,
 * the selection or the committed ink changes, or when the override of a
 * stroke outside the runs changes.
 */
export class InkLayers {
  private inks: readonly PaintInk[] | null = null
  private ghosts: readonly PaintInk[] | null = null
  /** The committed and ghost strokes in paint order, and the position of each. */
  private order: PaintInk[] = []
  private position = new Map<string, number>()
  /** The count of highlighters at the start of the order (changing highlighters go after them). */
  private highlighters = 0
  /** The strokes of the order that have an override now. */
  private overridden = new Set<string>()
  /** Nodes whose override changed since the last paint (null: any). */
  private pending: Set<string> | null = null
  /** The strokes whose override changed in the last HOLD_MS, with the time of the last change. */
  private active = new Map<string, number>()
  /** The runs of the order that the live canvas draws in each frame (none: the static canvas holds all strokes). */
  private runs: Run[] = []
  /** The view and the selection that the static canvas and the pictures show ('' : not drawn). */
  private key = ''
  /** The end of the strokes on the static canvas. */
  private baseEnd = -1
  /** pictures[i]: the strokes [lo, hi) after runs[i], up to the next run or the end. */
  private pictures: Array<{ canvas: HTMLCanvasElement; lo: number; hi: number }> = []
  private liveUsed = false

  /** The overrides of these nodes changed (null: of any node). Call it for each playback frame. */
  note(changed: ReadonlySet<string> | null | undefined): void {
    if (!changed) this.pending = null
    else if (this.pending) for (const id of changed) this.pending.add(id)
  }

  /** Paint the ink: the static canvas and the pictures when they are out of date, and the live canvas. */
  paint(base: HTMLCanvasElement | null, live: HTMLCanvasElement | null, input: InkPaint): void {
    if (!base || !live) return
    const { overrides, transients, viewport, camera } = input
    // The order of the committed and ghost strokes. full: every layer is out of date.
    let full = false
    if (input.inks !== this.inks || input.ghosts !== this.ghosts) {
      this.inks = input.inks
      this.ghosts = input.ghosts
      const all = input.ghosts.length ? [...input.inks, ...input.ghosts] : input.inks
      this.order = [...all.filter((ink) => ink.node.tool === 'highlighter'), ...all.filter((ink) => ink.node.tool !== 'highlighter')]
      this.highlighters = this.order.findIndex((ink) => ink.node.tool !== 'highlighter')
      if (this.highlighters < 0) this.highlighters = this.order.length
      this.position = new Map(this.order.map((ink, i) => [ink.node.id, i]))
      full = true
    }
    // The strokes whose override changed: the noted ones, or all that have or had one.
    const changed: Iterable<string> = this.pending ?? new Set([...this.overridden, ...(overrides?.keys() ?? [])])
    // The strokes with an override now.
    let presence = false
    if (!overrides) {
      presence = this.overridden.size > 0
      this.overridden.clear()
    } else if (this.pending === null || full) {
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
      if (!inRuns(at)) stale.push(at)
    }
    let rebuild = full || stale.length > 0
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
    const key = `${viewport[0]},${viewport[1]},${dpr},${camera.center[0]},${camera.center[1]},${camera.zoom}|${input.selected.join(',')}`
    if (key !== this.key || (presence && input.selected.length)) rebuild = full = true // the glow shows only under strokes without an override
    else if (!needed.length) rebuild ||= this.runs.length > 0
    else if (needed.some((run) => !this.runs.some((own) => run.lo >= own.lo && run.hi <= own.hi))) rebuild = true
    else if (strokesIn(this.runs) - strokesIn(needed) > Math.max(64, strokesIn(needed))) rebuild = true // much more than needed
    if (rebuild) {
      const n = this.order.length
      const runs = needed.map((run, i) => ({ lo: run.lo, hi: Math.min(n, run.hi + RUN_AHEAD, needed[i + 1]?.lo ?? n) }))
      this.drawStatic(base, input, runs, key, full, stale)
    }
    this.drawLive(live, input, transientHighlighter, transientPen)
  }

  /**
   * The static canvas (glow and the strokes before the first run) and the
   * pictures after the runs, each stroke with its override now. A layer is
   * drawn again only when its span of the order changed or holds a stale
   * stroke (full: every layer).
   */
  private drawStatic(base: HTMLCanvasElement, input: InkPaint, runs: Run[], key: string, full: boolean, stale: readonly number[]): void {
    this.runs = runs
    this.key = key
    const fresh = (lo: number, hi: number): boolean => !full && !stale.some((at) => at >= lo && at < hi)
    const { viewport, camera, overrides } = input
    const visible = visibleRegion(viewport, camera)
    const order = this.order
    const draw = (context: CanvasRenderingContext2D, from: number, to: number): void => {
      for (let i = from; i < to; i++) {
        const ink = order[i]
        const override = overrides?.get(ink.node.id)
        if (override?.opacity === 0) continue
        // A moving stroke is drawn wherever it is now: skip only unmoved strokes outside the view.
        if (!override?.matrix) {
          const bounds = inkBounds(ink.node, ink.offset)
          if (!bounds || !regionsIntersect(bounds, visible)) continue
        }
        drawInk(context, ink, 0, override)
      }
    }
    const baseEnd = runs.length ? runs[0].lo : order.length
    if (baseEnd !== this.baseEnd || !fresh(0, baseEnd)) {
      this.baseEnd = baseEnd
      const context = prepare(base, viewport, camera)
      if (!context) return
      if (input.selected.length) {
        const selected = new Set(input.selected)
        for (const ink of order) {
          if (!selected.has(ink.node.id) || overrides?.has(ink.node.id)) continue
          const bounds = inkBounds(ink.node, ink.offset)
          if (bounds && regionsIntersect(bounds, visible)) drawGlow(context, ink, camera.zoom)
        }
      }
      draw(context, 0, baseEnd)
    }
    // Each picture: an earlier picture of the same span when it is fresh, else drawn again.
    const old = this.pictures
    this.pictures = runs.map((run, i) => {
      const lo = run.hi
      const hi = runs[i + 1]?.lo ?? order.length
      const same = old.findIndex((picture) => picture.lo === lo && picture.hi === hi)
      if (same >= 0 && fresh(lo, hi)) return old.splice(same, 1)[0]
      const picture = { canvas: old.pop()?.canvas ?? document.createElement('canvas'), lo, hi }
      const context = prepare(picture.canvas, viewport, camera)
      if (context) draw(context, lo, hi)
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
          const bounds = inkBounds(ink.node, ink.offset)
          if (!bounds || !regionsIntersect(bounds, visible)) continue
        }
        drawInk(context, ink, 0, override)
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
  for (const ink of strokes) if (ink.node.tool === 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id))
  for (const ink of strokes) if (ink.node.tool !== 'highlighter') drawInk(context, ink, 0, overrides?.get(ink.node.id))
  drawTips(context, playback?.tips ?? [], camera.zoom)
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
