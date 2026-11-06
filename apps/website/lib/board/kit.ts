/**
 * The hero's drawing kit, built on the app's own code (the copied files in this folder):
 * hand-written text is write() (write.ts) with the board's wobble and pressure (hand.ts),
 * pen doodles are polylineInk + humanize, as pen shapes on the board, and all ink is painted
 * with the board's drawStroke (paint.ts). Plain shapes are plain round-capped strokes, as the
 * board draws circle, line, rect and arrow without pen: true (live/compile.ts).
 */
import { hex } from './colors'
import { humanize, strokeSeed, type InkPoint, type Point } from './hand'
import { polylineInk } from './ink-points'
import { drawStroke, ranges, revealPoints } from './paint'
import { mulberry32 } from './random'
import { writeInk } from './write'

export type { Point }
type Ctx = CanvasRenderingContext2D

const lengthOf = (line: readonly (readonly number[])[]): number => {
  let sum = 0
  for (let i = 1; i < line.length; i++) sum += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  return sum
}

/**
 * One ink object: strokes that draw one after the other, each in a time proportional to its
 * length with a short lift between strokes (the board's ranges()). A finished stroke is painted
 * once into a bitmap and blitted after that, but only one device pixel to one: the bitmap is
 * made in device pixels at the canvas's exact scale and sub-pixel offset, and drawn at a whole
 * device pixel. A bitmap scaled, shifted by part of a pixel or turned when it is drawn would be
 * resampled, and the ink would look soft; so under a turned or skewed transform the strokes are
 * drawn as paths.
 */
export class Ink {
  readonly ranges: [number, number][]
  readonly box: { x0: number; y0: number; x1: number; y1: number }
  /** The bitmap of the strokes drawn so far, in device pixels; `baked` strokes are in it. */
  private cache: { canvas: HTMLCanvasElement; c: CanvasRenderingContext2D; scale: number; fx: number; fy: number; baked: number } | null = null

  constructor(
    readonly strokes: InkPoint[][],
    readonly color: string,
    readonly width: number,
    /** Seconds the board takes to draw it (naturalDraw in the stage). */
    readonly duration: number
  ) {
    this.ranges = ranges(strokes.map(lengthOf))
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of strokes)
      for (const [x, y] of s) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    this.box = { x0, y0, x1, y1 }
  }

  /**
   * Draw the first `share` (0..1) of the ink. Finished strokes go into the bitmap once, so a
   * frame paints one bitmap and at most the one stroke being drawn.
   */
  draw(ctx: Ctx, share = 1, alpha = 1): void {
    if (share <= 0 || alpha <= 0 || !this.strokes.length) return
    let done = 0
    while (done < this.strokes.length && (share >= 1 || this.ranges[done][1] <= share)) done++
    const color = hex(this.color)
    const m = ctx.getTransform()
    // Only a plain scale and shift maps the bitmap's pixels onto the canvas's pixels one to one.
    const plain = m.a > 0 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.a - m.d) < 1e-9
    if (!plain) {
      for (let i = 0; i < done; i++) drawStroke(ctx, { points: this.strokes[i], color, width: this.width }, 0, alpha, this.strokes[i])
    } else if (done) {
      const pad = this.width + 2
      // The bitmap's top left in device pixels: a whole pixel, and the part of a pixel the bitmap holds.
      const gx = (this.box.x0 - pad) * m.a + m.e
      const gy = (this.box.y0 - pad) * m.d + m.f
      const ix = Math.floor(gx)
      const iy = Math.floor(gy)
      const k = this.bitmap(m.a, gx - ix, gy - iy)
      if (done < k.baked) {
        k.c.save()
        k.c.setTransform(1, 0, 0, 1, 0, 0)
        k.c.clearRect(0, 0, k.canvas.width, k.canvas.height)
        k.c.restore()
        k.baked = 0
      }
      for (; k.baked < done; k.baked++) {
        const points = this.strokes[k.baked]
        drawStroke(k.c, { points, color, width: this.width }, 0, 1, points)
      }
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha *= Math.min(1, alpha)
      ctx.drawImage(k.canvas, ix, iy)
      ctx.restore()
    }
    if (done < this.strokes.length) {
      const [r0, r1] = this.ranges[done]
      const part = r1 > r0 ? (share - r0) / (r1 - r0) : 0
      const points = this.strokes[done]
      if (part > 0) drawStroke(ctx, { points: revealPoints(points, part), color, width: this.width }, 0, alpha, points)
    }
  }

  /** The bitmap at this scale and sub-pixel offset: made again (empty) when either changes. */
  private bitmap(scale: number, fx: number, fy: number) {
    const k = this.cache
    if (!k || Math.abs(k.scale - scale) > 1e-6 || Math.abs(k.fx - fx) > 1e-3 || Math.abs(k.fy - fy) > 1e-3) {
      const pad = this.width + 2
      const x = this.box.x0 - pad
      const y = this.box.y0 - pad
      const canvas = k?.canvas ?? document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil((this.box.x1 - this.box.x0 + pad * 2) * scale + 1))
      canvas.height = Math.max(1, Math.ceil((this.box.y1 - this.box.y0 + pad * 2) * scale + 1))
      const c = canvas.getContext('2d')!
      c.setTransform(scale, 0, 0, scale, fx - x * scale, fy - y * scale)
      c.lineCap = 'round'
      c.lineJoin = 'round'
      this.cache = { canvas, c, scale, fx, fy, baked: 0 }
    }
    return this.cache!
  }
}

const textSeed = (text: string, x: number, y: number): number => strokeSeed(text, [[x, y]])

/** Hand-written text, as write(text, {size, at | center, color}) on the board. `at` is the top left of the ink. */
export function write(text: string, size: number, x: number, y: number, color = 'text', o: { center?: boolean; seed?: number } = {}): Ink {
  const w = writeInk(text, { size, color, ...(o.center ? { center: [x, y] } : { at: [x, y] }), seed: o.seed ?? textSeed(text, x, y) })
  const key = `${text}@${x},${y}`
  const strokes = w.lines.map((line, i) => humanize(line, w.jitter, mulberry32(strokeSeed(`${key}:${i}`, line))))
  const length = w.lines.reduce((sum, l) => sum + lengthOf(l), 0)
  return new Ink(strokes, color, w.width, Math.max(0.25, length / w.speed + w.lines.length * 0.05))
}

/** A pen shape: the polylines as hand-drawn ink (pen: true on the board). */
export function pen(lines: Point[][], color = 'text', width = 3, jitter = 0.3, key = 'pen'): Ink {
  const runs = polylineInk(lines)
  const strokes = runs.map((l, i) => humanize(l, jitter, mulberry32(strokeSeed(`${key}:${i}`, l))))
  const length = lines.reduce((sum, l) => sum + lengthOf(l), 0)
  return new Ink(strokes, color, width, Math.max(0.25, length / 450))
}

// ---------- Geometry ----------

export function arc(cx: number, cy: number, r: number, a0 = 0, a1 = Math.PI * 2, n = 0): Point[] {
  const steps = n || Math.max(8, Math.ceil((Math.abs(a1 - a0) * r) / 4))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Point
  })
}

export function oval(cx: number, cy: number, rx: number, ry: number, rot = 0, a0 = 0, a1 = Math.PI * 2): Point[] {
  const steps = Math.max(12, Math.ceil((Math.abs(a1 - a0) * Math.max(rx, ry)) / 4))
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps
    const x = rx * Math.cos(a)
    const y = ry * Math.sin(a)
    return [cx + x * c - y * s, cy + x * s + y * c] as Point
  })
}

export const box = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y]
]

export function star(cx: number, cy: number, r: number, points = 5, inner = 0.45): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const rr = i % 2 ? r * inner : r
    out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
  }
  return out
}

// ---------- Time ----------

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
/** The time inside a loop of `period` seconds. */
export const cyc = (t: number, period: number, offset = 0): number => (((t + offset) % period) + period) % period
/** The share of an ink drawn `local - start` seconds after it starts. */
export const share = (local: number, start: number, ink: Ink, pace = 1): number => clamp01(((local - start) * pace) / ink.duration)
/** 1, then down to 0 over the last `out` seconds of the loop. */
export const fadeEnd = (local: number, period: number, out = 0.8): number => clamp01((period - local) / out)
export const ease = (v: number): number => {
  const k = clamp01(v)
  return k * k * (3 - 2 * k)
}

// ---------- The painter ----------

/** Plain strokes and ink on one canvas; `a` multiplies every alpha. */
export class Pen {
  a = 1
  constructor(readonly ctx: Ctx) {}

  private stroke(color: string, width: number): void {
    const c = this.ctx
    c.strokeStyle = hex(color)
    c.lineWidth = width
    c.globalAlpha = this.a
    c.stroke()
    c.globalAlpha = 1
  }

  line(pts: readonly Point[], color = 'text', width = 3, close = false): void {
    if (pts.length < 2) return
    const c = this.ctx
    c.beginPath()
    c.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1])
    if (close) c.closePath()
    this.stroke(color, width)
  }

  seg(x1: number, y1: number, x2: number, y2: number, color = 'text', width = 3): void {
    const c = this.ctx
    c.beginPath()
    c.moveTo(x1, y1)
    c.lineTo(x2, y2)
    this.stroke(color, width)
  }

  circle(x: number, y: number, r: number, color = 'text', width = 3, a0 = 0, a1 = Math.PI * 2): void {
    const c = this.ctx
    c.beginPath()
    c.arc(x, y, Math.max(0, r), a0, a1)
    this.stroke(color, width)
  }

  ellipse(x: number, y: number, rx: number, ry: number, rot: number, color = 'text', width = 3, a0 = 0, a1 = Math.PI * 2): void {
    const c = this.ctx
    c.beginPath()
    c.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot, a0, a1)
    this.stroke(color, width)
  }

  /** The board's arrow: head max(10, min(22, 0.2·length, 5·width)), wings ±0.45 rad. */
  arrow(x1: number, y1: number, x2: number, y2: number, color = 'text', width = 3, head?: number): void {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1
    const ux = (x2 - x1) / length
    const uy = (y2 - y1) / length
    const h = head ?? Math.max(10, Math.min(22, length * 0.2, width * 5))
    const wing = (angle: number): Point => {
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      return [x2 - h * (ux * c - uy * s), y2 - h * (uy * c + ux * s)]
    }
    const [ax, ay] = wing(0.45)
    const [bx, by] = wing(-0.45)
    const c = this.ctx
    c.beginPath()
    c.moveTo(x1, y1)
    c.lineTo(x2, y2)
    c.moveTo(ax, ay)
    c.lineTo(x2, y2)
    c.lineTo(bx, by)
    this.stroke(color, width)
  }

  dot(x: number, y: number, r: number, color = 'text', alpha = 1): void {
    const c = this.ctx
    c.beginPath()
    c.arc(x, y, Math.max(0, r), 0, Math.PI * 2)
    c.fillStyle = hex(color)
    c.globalAlpha = this.a * alpha
    c.fill()
    c.globalAlpha = 1
  }

  fill(pts: readonly Point[], color: string, alpha = 1): void {
    if (pts.length < 3) return
    const c = this.ctx
    c.beginPath()
    c.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1])
    c.closePath()
    c.fillStyle = hex(color)
    c.globalAlpha = this.a * alpha
    c.fill()
    c.globalAlpha = 1
  }

  ink(ink: Ink, part = 1, alpha = 1): void {
    ink.draw(this.ctx, part, alpha * this.a)
  }

  /** Draw `fn` with the alpha multiplied by `a`. */
  fade(a: number, fn: () => void): void {
    if (a <= 0) return
    const old = this.a
    this.a *= a
    fn()
    this.a = old
  }

  /** Draw `fn` moved to x, y, turned by `rot` radians and scaled by `s`. */
  at(x: number, y: number, rot: number, s: number, fn: () => void): void {
    const c = this.ctx
    c.save()
    c.translate(x, y)
    if (rot) c.rotate(rot)
    if (s !== 1) c.scale(s, s)
    fn()
    c.restore()
  }
}
