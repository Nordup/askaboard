import type { InkPoint } from '../../../shared/board-format'

/**
 * A pen stroke from a pointer with no pressure, a mouse or a trackpad: the
 * pressure of each point comes from the speed, so the stroke looks handwritten.
 * The one place for this logic, and only capture uses it: an old stroke with
 * pressure 0.5 keeps its look.
 *
 * A point that has settled on the canvas must not change while the pointer is
 * down (ActiveInk). So a point gets its final look when it is stored, and only
 * the end taper rewrites points, at pointer up.
 *
 * Distances here are in screen pixels and speeds in screen pixels per
 * millisecond, so that a stroke feels the same at each zoom.
 */

/** The share of the way that a value moves in one sample at the reference rate. */
const POINT_SMOOTHING = 0.55
const SPEED_SMOOTHING = 0.3
const PRESSURE_SMOOTHING = 0.3
/** The gap between samples that these shares are for. A faster mouse sends more samples, and each sample moves less. */
const REFERENCE_MS = 16.7

const START_PRESSURE = 0.6
const SLOW_PRESSURE = 0.62
/** The pressure that the top speed takes away, at the approved speed effect of 60. */
const SPEED_EFFECT = 0.6 * 0.42
const TOP_SPEED = 1.4

const START_TAPER = 14
const END_TAPER = 22
/** The thinnest share of the pressure at the two ends of a stroke. */
const TAPER_FLOOR = 0.3
/** Under this length, the end taper grows less pointed, down to none: a short stroke stays readable. */
const SHORT_STROKE = 30
/** Under this length, a stroke is a mark, such as a dot that moved a little. It gets no thin ends. */
const MARK_LENGTH = 8
const MARK_PRESSURE = 0.5
/** A press that stays this close to its start is a click, and it makes a dot. */
const CLICK_RADIUS = 2
/** The same rule as the pen: a smaller move stores no point. */
const MIN_STEP = 0.5
/** In a taper, a gap wider than this gets more points, because each point has one width. */
const TAPER_STEP = 3

const pressureRange = (value: number): number => Math.min(1, Math.max(0, value))
const blend = (share: number, milliseconds: number): number => 1 - (1 - share) ** (milliseconds / REFERENCE_MS)
const taper = (distance: number, reach: number, floor: number): number => floor + (1 - floor) * Math.min(1, distance / reach)

/** Where to place points along a gap: each TAPER_STEP inside `zone`, and always at the far end. */
function stops(gap: number, zone: number): number[] {
  const out: number[] = []
  for (let at = TAPER_STEP; at < Math.min(zone, gap); at += TAPER_STEP) out.push(at / gap)
  out.push(1)
  return out
}

export class MouseInk {
  /** The stored points. This array is the stroke in progress, and it only grows. */
  readonly points: InkPoint[]
  /** The true pointer position: the end of the unsettled piece. Null while the press can still be a click. */
  tip: [x: number, y: number] | null = null

  /** For each stored point, the screen pixels along the stroke. */
  private readonly along: number[] = [0]
  private readonly start: [x: number, y: number]
  private raw: [x: number, y: number]
  private time: number
  private speed = 0
  private pressure = START_PRESSURE

  constructor(x: number, y: number, time: number) {
    this.start = [x, y]
    this.raw = [x, y]
    this.time = time
    this.points = [[x, y, START_PRESSURE]]
  }

  /** One pointer sample, in board coordinates. */
  add(x: number, y: number, time: number, zoom: number): void {
    const milliseconds = Math.max(1, time - this.time)
    const moved = Math.hypot(x - this.raw[0], y - this.raw[1]) * zoom
    this.speed += (moved / milliseconds - this.speed) * blend(SPEED_SMOOTHING, milliseconds)
    const target = SLOW_PRESSURE - SPEED_EFFECT * Math.min(1, this.speed / TOP_SPEED)
    this.pressure += (target - this.pressure) * blend(PRESSURE_SMOOTHING, milliseconds)
    this.raw = [x, y]
    this.time = time

    if (!this.tip) {
      if (Math.hypot(x - this.start[0], y - this.start[1]) * zoom < CLICK_RADIUS) return
      // The press is a stroke. Nothing has settled yet, so the first point can still take the start taper.
      this.points[0][2] = pressureRange(START_PRESSURE * TAPER_FLOOR)
    }
    this.tip = [x, y]

    const [lastX, lastY] = this.points[this.points.length - 1]
    if (Math.hypot(x - lastX, y - lastY) * zoom < MIN_STEP) return
    const share = blend(POINT_SMOOTHING, milliseconds)
    this.store(lastX + (x - lastX) * share, lastY + (y - lastY) * share, zoom)
  }

  private store(x: number, y: number, zoom: number): void {
    const [lastX, lastY] = this.points[this.points.length - 1]
    const from = this.along[this.along.length - 1]
    const gap = Math.hypot(x - lastX, y - lastY) * zoom
    for (const share of stops(gap, START_TAPER - from)) {
      const distance = from + gap * share
      this.points.push([lastX + (x - lastX) * share, lastY + (y - lastY) * share, pressureRange(this.pressure * taper(distance, START_TAPER, TAPER_FLOOR))])
      this.along.push(distance)
    }
  }

  /** The pointer lifted at (x, y): the finished points, as a new array. */
  finish(x: number, y: number, zoom: number): InkPoint[] {
    if (!this.tip) return [[...this.points[0]]]
    const last = this.points[this.points.length - 1]
    if (last[0] !== x || last[1] !== y) this.store(x, y, zoom)

    const { points, along } = this
    const length = along[along.length - 1]
    if (length < MARK_LENGTH) return points.map(([px, py, p]) => [px, py, Math.max(p, MARK_PRESSURE)])

    const reach = Math.min(END_TAPER, length / 2)
    const floor = TAPER_FLOOR + (1 - TAPER_FLOOR) * Math.max(0, 1 - length / SHORT_STROKE)
    const out: InkPoint[] = []
    const write = (px: number, py: number, p: number, distance: number): void => {
      out.push([px, py, pressureRange(p * taper(length - distance, reach, floor))])
    }
    for (let i = 0; i < points.length; i++) {
      const [px, py, p] = points[i]
      write(px, py, p, along[i])
      if (i === points.length - 1 || length - along[i + 1] >= reach) continue
      const [nx, ny, np] = points[i + 1]
      const gap = along[i + 1] - along[i]
      for (const share of stops(gap, gap).slice(0, -1)) {
        write(px + (nx - px) * share, py + (ny - py) * share, p + (np - p) * share, along[i] + gap * share)
      }
    }
    return out
  }
}
