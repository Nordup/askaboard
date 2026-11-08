/**
 * The visitor's pen on the hero. It is the app's mouse pen (apps/desktop/src/renderer/src/board/mouse-ink.ts,
 * reproduced here): the pressure of a mouse or finger stroke comes from its speed, the ends taper,
 * and the points are painted with the board's own drawStroke (lib/board/paint.ts).
 * Coordinates are screen pixels while the pen is down; the caller maps the finished points.
 */

/** The nominal pen width (tools.ts PEN_WIDTHS.medium). */
export const PEN_WIDTH = 3.5

export type PenPoint = [x: number, y: number, pressure: number]

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

export class PenStroke {
  points: PenPoint[]
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
    const out: PenPoint[] = []
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
  shown(): PenPoint[] {
    if (!this.tip) return this.points
    const last = this.points[this.points.length - 1]
    return [...this.points, [this.tip[0], this.tip[1], last[2]]]
  }
}
