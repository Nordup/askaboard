/**
 * The visitor's ink on the hero. It looks like the app's pen: the pressure of a
 * mouse or finger stroke comes from its speed, the ends taper, and each piece
 * is a quadratic curve between segment midpoints with its own width
 * (space/src/renderer/src/board/mouse-ink.ts, reproduced here). It is painted with the
 * board's own drawStroke (lib/board/paint.ts, copied from the app).
 * A stroke stays HOLD_MS after the pen lifts, then fades over FADE_MS.
 */

import { drawStroke } from './board/paint'

type Point = [x: number, y: number, pressure: number]

/** A press that moves something else instead of drawing (a board piece being dragged). */
export interface Grab {
  move(x: number, y: number): void
  end(): void
}

export interface InkOptions {
  /** A press at x, y (host pixels): a grab when something there takes it, else null and the press draws. */
  grab?: (x: number, y: number) => Grab | null
  /** The pointer moved over the host with no button down. */
  hover?: (x: number, y: number) => void
}

const PEN_WIDTH = 3.5
const HOLD_MS = 2000
const FADE_MS = 1200
/** A touch must stay this long and this close to its start before it draws; a move before that is a scroll. */
const TOUCH_HOLD_MS = 220
const TOUCH_SLOP = 8

// The app's smoothing constants (mouse-ink.ts), in screen pixels and pixels per millisecond.
const POINT_SMOOTHING = 0.55
const SPEED_SMOOTHING = 0.3
const PRESSURE_SMOOTHING = 0.3
const REFERENCE_MS = 16.7
const START_PRESSURE = 0.6
const SLOW_PRESSURE = 0.62
const SPEED_EFFECT = 0.6 * 0.42
const TOP_SPEED = 1.4
const START_TAPER = 14
const END_TAPER = 22
const TAPER_FLOOR = 0.3
const SHORT_STROKE = 30
const MARK_LENGTH = 8
const MARK_PRESSURE = 0.5
const MIN_STEP = 0.5
const TAPER_STEP = 3

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const blend = (share: number, ms: number): number => 1 - (1 - share) ** (ms / REFERENCE_MS)
const taper = (distance: number, reach: number, floor: number): number => floor + (1 - floor) * Math.min(1, distance / reach)

function stops(gap: number, zone: number): number[] {
  const out: number[] = []
  for (let at = TAPER_STEP; at < Math.min(zone, gap); at += TAPER_STEP) out.push(at / gap)
  out.push(1)
  return out
}

class Stroke {
  points: Point[]
  /** The true pointer position while the pen is down. */
  tip: [number, number] | null = null
  /** When the pen lifted; null while it is down. */
  ended: number | null = null
  private along = [0]
  private raw: [number, number]
  private time: number
  private speed = 0
  private pressure = START_PRESSURE

  constructor(x: number, y: number, time: number) {
    this.raw = [x, y]
    this.time = time
    this.points = [[x, y, START_PRESSURE]]
  }

  add(x: number, y: number, time: number): void {
    const ms = Math.max(1, time - this.time)
    this.speed += (Math.hypot(x - this.raw[0], y - this.raw[1]) / ms - this.speed) * blend(SPEED_SMOOTHING, ms)
    const target = SLOW_PRESSURE - SPEED_EFFECT * Math.min(1, this.speed / TOP_SPEED)
    this.pressure += (target - this.pressure) * blend(PRESSURE_SMOOTHING, ms)
    this.raw = [x, y]
    this.time = time
    if (!this.tip) {
      if (Math.hypot(x - this.points[0][0], y - this.points[0][1]) < 2) return
      this.points[0][2] = START_PRESSURE * TAPER_FLOOR
    }
    this.tip = [x, y]
    const [lx, ly] = this.points[this.points.length - 1]
    if (Math.hypot(x - lx, y - ly) < MIN_STEP) return
    const share = blend(POINT_SMOOTHING, ms)
    this.store(lx + (x - lx) * share, ly + (y - ly) * share)
  }

  private store(x: number, y: number): void {
    const [lx, ly] = this.points[this.points.length - 1]
    const from = this.along[this.along.length - 1]
    const gap = Math.hypot(x - lx, y - ly)
    for (const share of stops(gap, START_TAPER - from)) {
      const distance = from + gap * share
      this.points.push([lx + (x - lx) * share, ly + (y - ly) * share, clamp01(this.pressure * taper(distance, START_TAPER, TAPER_FLOOR))])
      this.along.push(distance)
    }
  }

  finish(time: number): void {
    this.ended = time
    if (!this.tip) return
    const [x, y] = this.tip
    const last = this.points[this.points.length - 1]
    if (last[0] !== x || last[1] !== y) this.store(x, y)
    this.tip = null
    const { points, along } = this
    const length = along[along.length - 1]
    if (length < MARK_LENGTH) {
      this.points = points.map(([px, py, p]) => [px, py, Math.max(p, MARK_PRESSURE)])
      return
    }
    const reach = Math.min(END_TAPER, length / 2)
    const floor = TAPER_FLOOR + (1 - TAPER_FLOOR) * Math.max(0, 1 - length / SHORT_STROKE)
    const out: Point[] = []
    const write = (px: number, py: number, p: number, distance: number): void => {
      out.push([px, py, clamp01(p * taper(length - distance, reach, floor))])
    }
    for (let i = 0; i < points.length; i++) {
      const [px, py, p] = points[i]
      write(px, py, p, along[i])
      if (i === points.length - 1 || length - along[i + 1] >= reach) continue
      const [nx, ny, np] = points[i + 1]
      const gap = along[i + 1] - along[i]
      for (const share of stops(gap, gap).slice(0, -1)) write(px + (nx - px) * share, py + (ny - py) * share, p + (np - p) * share, along[i] + gap * share)
    }
    this.points = out
  }

  /** The points to paint: the stored points, then the unsettled piece to the tip. */
  shown(): Point[] {
    if (!this.tip) return this.points
    const last = this.points[this.points.length - 1]
    return [...this.points, [this.tip[0], this.tip[1], last[2]]]
  }
}

/** Is this press for the page (a link or a button), not for the ink? */
const isControl = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('a, button')

/**
 * Let the visitor draw on `host`; the ink shows on `canvas`, which covers host.
 * Mouse and pen draw at once. A finger scrolls the page; it draws only after
 * it rests TOUCH_HOLD_MS in place (press and hold, then draw). Returns detach.
 */
export function attachInk(host: HTMLElement, canvas: HTMLCanvasElement, options: InkOptions = {}): () => void {
  const context = canvas.getContext('2d')!
  // A scratch canvas: a fading stroke is painted opaque here first, so its overlapping pieces fade as one.
  const scratch = document.createElement('canvas')
  const scratchContext = scratch.getContext('2d')!
  const color = getComputedStyle(host).getPropertyValue('--ink').trim() || '#ececef'
  const strokes: Stroke[] = []
  let active: Stroke | null = null
  let grabbed: Grab | null = null
  let frame = 0
  const paint = (c: CanvasRenderingContext2D, points: Point[]): void => drawStroke(c, { points, color, width: PEN_WIDTH })

  const local = (clientX: number, clientY: number): [number, number] => {
    const r = host.getBoundingClientRect()
    return [clientX - r.left, clientY - r.top]
  }

  const fit = (): boolean => {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(host.clientWidth * dpr))
    const h = Math.max(1, Math.round(host.clientHeight * dpr))
    if (canvas.width === w && canvas.height === h) return false
    canvas.width = scratch.width = w
    canvas.height = scratch.height = h
    return true
  }

  const setup = (c: CanvasRenderingContext2D): void => {
    const dpr = canvas.width / Math.max(1, host.clientWidth)
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.strokeStyle = c.fillStyle = color
  }

  const render = (): void => {
    frame = 0
    fit()
    const now = performance.now()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    setup(context)
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i]
      const age = stroke.ended === null ? 0 : now - stroke.ended
      const alpha = age < HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS
      if (alpha <= 0) {
        strokes.splice(i, 1)
        continue
      }
      if (alpha >= 1) {
        paint(context, stroke.shown())
        continue
      }
      scratchContext.setTransform(1, 0, 0, 1, 0, 0)
      scratchContext.clearRect(0, 0, scratch.width, scratch.height)
      setup(scratchContext)
      paint(scratchContext, stroke.shown())
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = alpha
      context.drawImage(scratch, 0, 0)
      context.restore()
    }
    if (strokes.length) frame = requestAnimationFrame(render)
  }
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  const begin = (x: number, y: number): void => {
    active = new Stroke(x, y, performance.now())
    strokes.push(active)
    schedule()
  }
  const move = (x: number, y: number): void => {
    active?.add(x, y, performance.now())
    schedule()
  }
  const end = (): void => {
    active?.finish(performance.now())
    active = null
    schedule()
  }

  // Mouse and pen: pointer events.
  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.button !== 0 || isControl(e.target)) return
    e.preventDefault()
    host.setPointerCapture(e.pointerId)
    const at = local(e.clientX, e.clientY)
    grabbed = options.grab?.(...at) ?? null
    if (!grabbed) begin(...at)
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    if (grabbed) return grabbed.move(...local(e.clientX, e.clientY))
    if (!active) return options.hover?.(...local(e.clientX, e.clientY))
    for (const p of e.getCoalescedEvents?.() ?? [e]) move(...local(p.clientX, p.clientY))
  }
  const release = (): void => {
    grabbed?.end()
    grabbed = null
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    release()
    end()
  }

  // A finger: touch events, so the page keeps its own one-finger scroll.
  let hold = 0
  let pressAt: [number, number] | null = null
  let last: [number, number] = [0, 0]
  const cancelHold = (): void => {
    clearTimeout(hold)
    pressAt = null
  }
  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1 || isControl(e.target)) return cancelHold()
    const t = e.touches[0]
    // A stylus (Apple Pencil) is a pen; pointer events draw it.
    if ((t as Touch & { touchType?: string }).touchType === 'stylus') return
    pressAt = last = [t.clientX, t.clientY]
    clearTimeout(hold)
    hold = window.setTimeout(() => {
      if (!pressAt) return
      const at = local(...last)
      grabbed = options.grab?.(...at) ?? null
      if (!grabbed) begin(...at)
      navigator.vibrate?.(8)
    }, TOUCH_HOLD_MS)
  }
  const onTouchMove = (e: TouchEvent): void => {
    if (grabbed) {
      e.preventDefault()
      if (e.touches.length === 1) grabbed.move(...local(e.touches[0].clientX, e.touches[0].clientY))
      return
    }
    if (active) {
      // Drawing: this finger no longer scrolls. A pen stroke ends up here too.
      e.preventDefault()
      if (e.touches.length === 1 && (e.touches[0] as Touch & { touchType?: string }).touchType !== 'stylus') {
        move(...local(e.touches[0].clientX, e.touches[0].clientY))
      }
      return
    }
    if (!pressAt || e.touches.length !== 1) return cancelHold()
    const t = e.touches[0]
    last = [t.clientX, t.clientY]
    if (Math.hypot(last[0] - pressAt[0], last[1] - pressAt[1]) > TOUCH_SLOP) cancelHold()
  }
  const onTouchEnd = (): void => {
    cancelHold()
    release()
    if (active) end()
  }
  const onContextMenu = (e: Event): void => {
    if (!isControl(e.target)) e.preventDefault()
  }

  const resize = new ResizeObserver(schedule)
  resize.observe(host)
  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', onPointerUp)
  host.addEventListener('touchstart', onTouchStart, { passive: true })
  host.addEventListener('touchmove', onTouchMove, { passive: false })
  host.addEventListener('touchend', onTouchEnd)
  host.addEventListener('touchcancel', onTouchEnd)
  host.addEventListener('contextmenu', onContextMenu)
  return () => {
    cancelAnimationFrame(frame)
    cancelHold()
    resize.disconnect()
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerup', onPointerUp)
    host.removeEventListener('pointercancel', onPointerUp)
    host.removeEventListener('touchstart', onTouchStart)
    host.removeEventListener('touchmove', onTouchMove)
    host.removeEventListener('touchend', onTouchEnd)
    host.removeEventListener('touchcancel', onTouchEnd)
    host.removeEventListener('contextmenu', onContextMenu)
  }
}
