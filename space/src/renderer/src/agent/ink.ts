import type { InkPoint } from '@shared/board-format'
import { MAX_COORD, MAX_INK_POINTS, MAX_SVG_PATH_CHARS } from '@shared/limits'
import type { Point, Region } from '../board/types'

/**
 * Agent ink that looks drawn by hand: SVG paths sampled into points, shapes
 * (circle, underline, tick, cross, arrow) built from a target box, and a
 * pressure profile with a taper at both ends and a slight wobble.
 */

/** Points closer than this are merged; longer segments are split (board points). */
const SAMPLE_STEP = 2.5
/** The longest svg_path: its samples, SAMPLE_STEP apart, fit within MAX_INK_POINTS. */
const MAX_SVG_LENGTH = MAX_INK_POINTS * SAMPLE_STEP

/**
 * The points humanize() makes from these polylines, without making them:
 * the raw points plus one point every SAMPLE_STEP along each segment.
 * Throws when a coordinate is not finite or is outside ±MAX_COORD.
 */
export function inkPointBudget(lines: readonly Point[][]): number {
  let budget = 0
  for (const line of lines) {
    budget += line.length
    for (let i = 0; i < line.length; i++) {
      const [x, y] = line[i]
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
        throw new Error(`Ink coordinates must be finite and within ±${MAX_COORD} board points.`)
      }
      if (i > 0) budget += Math.hypot(x - line[i - 1][0], y - line[i - 1][1]) / SAMPLE_STEP
    }
  }
  return budget
}

/**
 * Sample an SVG path `d` into polylines (one per subpath), using the browser's
 * own path geometry. `capped` applies draw_ink's limits; live scenes have none.
 */
export function svgPathPolylines(d: string, capped = true): Point[][] {
  if (capped && d.length > MAX_SVG_PATH_CHARS) throw new Error(`svg_path is too long (over ${MAX_SVG_PATH_CHARS} characters).`)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.visibility = 'hidden'
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)
  try {
    const total = path.getTotalLength()
    if (!Number.isFinite(total) || total <= 0) throw new Error('svg_path has no length. Give a path "d" string such as "M0 0 L40 0".')
    if (capped && total > MAX_SVG_LENGTH) throw new Error(`svg_path is too long (over ${MAX_SVG_LENGTH} board points of length).`)
    // Sampled finer than SAMPLE_STEP, then simplified; the count stays below 2 × MAX_INK_POINTS.
    const count = Math.max(2, Math.ceil(total / 1.5))
    const out: Point[][] = []
    let current: Point[] = []
    let last: Point | null = null
    for (let i = 0; i <= count; i++) {
      const p = path.getPointAtLength((total * i) / count)
      const point: Point = [p.x, p.y]
      // A moveto shows as a jump much longer than the sampling step: start a new polyline there.
      if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) > (total / count) * 3 + 0.5) {
        if (current.length > 1) out.push(current)
        current = []
      }
      current.push(point)
      last = point
    }
    if (current.length > 1) out.push(current)
    return out.map((line) => simplify(line, SAMPLE_STEP))
  } finally {
    svg.remove()
  }
}

/** Keep points at least `step` apart (and always the last one). */
function simplify(line: Point[], step: number): Point[] {
  if (line.length < 3) return line
  const out: Point[] = [line[0]]
  for (let i = 1; i < line.length - 1; i++) {
    const prev = out[out.length - 1]
    if (Math.hypot(line[i][0] - prev[0], line[i][1] - prev[1]) >= step) out.push(line[i])
  }
  out.push(line[line.length - 1])
  return out
}

/** Split long segments, so wobble and pressure have points to act on. */
function densify(line: Point[], step: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[i]
    if (i > 0) {
      const q = line[i - 1]
      const parts = Math.floor(Math.hypot(p[0] - q[0], p[1] - q[1]) / step)
      for (let k = 1; k < parts; k++) out.push([q[0] + ((p[0] - q[0]) * k) / parts, q[1] + ((p[1] - q[1]) * k) / parts])
    }
    out.push(p)
  }
  return out
}

/**
 * Make a polyline look hand-drawn: a low-frequency sideways wobble scaled by
 * `jitter` (0..1), and pressure that rises at the start, varies a little and
 * falls at the end.
 */
export function humanize(line: Point[], jitter: number, random: () => number = Math.random): InkPoint[] {
  const dense = densify(line, SAMPLE_STEP)
  const lengths = [0]
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]))
  const total = lengths[lengths.length - 1] || 1
  const taper = Math.min(18, total * 0.18)
  const phase = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2]
  const amplitude = Math.max(0, Math.min(1, jitter)) * 2.2
  const base = 0.5 + random() * 0.1
  return dense.map((point, i) => {
    const s = lengths[i]
    // Sideways direction: the normal of the local segment.
    const a = dense[Math.max(0, i - 1)]
    const b = dense[Math.min(dense.length - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / len
    const ny = (b[0] - a[0]) / len
    const wobble = amplitude * (0.7 * Math.sin(s / 23 + phase[0]) + 0.3 * Math.sin(s / 7.3 + phase[1]))
    const rise = Math.min(1, s / Math.max(1, taper))
    const fall = Math.min(1, (total - s) / Math.max(1, taper * 1.4))
    const ends = 0.25 + 0.75 * Math.min(rise, fall)
    const pressure = Math.max(0.08, Math.min(1, base * ends + 0.05 * Math.sin(s / 31 + phase[2])))
    return [point[0] + nx * wobble, point[1] + ny * wobble, Math.round(pressure * 100) / 100]
  })
}

// ---------- Shapes from a target box ----------

export type Shape = 'circle' | 'underline' | 'tick' | 'cross' | 'arrow'
export const SHAPES: readonly Shape[] = ['circle', 'underline', 'tick', 'cross', 'arrow']
export type ArrowSide = 'left' | 'right' | 'above' | 'below'

/** A loose ellipse around the box that overshoots its start a little, like a quick hand circle. */
function circleAround(box: Region, random: () => number): Point[][] {
  const pad = 8 + 0.08 * Math.max(box.width, box.height)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const rx = box.width / 2 + pad
  const ry = box.height / 2 + pad
  const start = Math.PI * (1.05 + random() * 0.2)
  const sweep = Math.PI * 2 * 1.08
  const line: Point[] = []
  const steps = 96
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const angle = start - sweep * t
    // The radius drifts a little, so the end does not meet the start.
    const drift = 1 + 0.05 * t + 0.02 * Math.sin(t * Math.PI * 3)
    line.push([cx + Math.cos(angle) * rx * drift, cy + Math.sin(angle) * ry * drift])
  }
  return [line]
}

function markSize(box: Region): number {
  return Math.max(16, Math.min(44, box.height * 0.6))
}

/** The top-left for a small mark of size `s` right of the box, centred on it. */
function besideBox(box: Region, s: number): Point {
  return [box.x + box.width + 14, box.y + box.height / 2 - s / 2]
}

function edgePoint(box: Region, toward: Point, pad: number): Point {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  const hw = box.width / 2 + pad
  const hh = box.height / 2 + pad
  if (!dx && !dy) return [cx, cy]
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  return [cx + dx * t, cy + dy * t]
}

/** An arrow: a slightly bowed shaft, then the head as one stroke (wing, tip, wing). */
export function arrowLines(from: Point, to: Point): Point[][] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const bow = Math.min(14, length * 0.06)
  const shaft: Point[] = []
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    const lift = Math.sin(t * Math.PI) * bow
    shaft.push([from[0] + dx * t - uy * lift, from[1] + dy * t + ux * lift])
  }
  const head = Math.max(9, Math.min(20, length * 0.18))
  const wing = (angle: number): Point => {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return [to[0] - head * (ux * cos - uy * sin), to[1] - head * (uy * cos + ux * sin)]
  }
  return [shaft, [wing(0.5), to, wing(-0.5)]]
}

/** The polylines (board points) of a shape for a target box. */
export function shapeLines(shape: Shape, box: Region, options: { from?: Region | null; side?: ArrowSide }, random: () => number = Math.random): Point[][] {
  switch (shape) {
    case 'circle':
      return circleAround(box, random)
    case 'underline': {
      const y = box.y + box.height + 6
      const x0 = box.x - 4
      const x1 = box.x + box.width + 6
      return [[[x0, y], [(x0 + x1) / 2, y + 2.5], [x1, y + 0.5]]]
    }
    case 'tick': {
      const s = markSize(box)
      const [x, y] = besideBox(box, s)
      return [[[x, y + s * 0.55], [x + s * 0.35, y + s], [x + s, y]]]
    }
    case 'cross': {
      const s = markSize(box) * 0.85
      const [x, y] = besideBox(box, s)
      return [
        [[x, y], [x + s, y + s]],
        [[x + s, y], [x, y + s]]
      ]
    }
    case 'arrow': {
      const centre: Point = [box.x + box.width / 2, box.y + box.height / 2]
      let start: Point
      if (options.from) {
        start = edgePoint(options.from, centre, 6)
      } else {
        const side = options.side ?? 'left'
        const reach = 90
        start =
          side === 'left'
            ? [box.x - reach, centre[1] - 30]
            : side === 'right'
              ? [box.x + box.width + reach, centre[1] - 30]
              : side === 'above'
                ? [centre[0] - 30, box.y - reach]
                : [centre[0] - 30, box.y + box.height + reach]
      }
      const end = edgePoint(box, start, 8)
      return arrowLines(start, end)
    }
  }
}
