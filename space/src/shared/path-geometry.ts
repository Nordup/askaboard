/**
 * SVG path geometry without the DOM: a strict parser of path strings into
 * absolute segments, and the flattening of segments into polylines. The
 * stage's worker (live-prelude.js, through stage/worker.ts) and the board use
 * the same code.
 *
 * Two flattenings:
 * - 'outline': fixed steps per curve (16 per cubic, 12 per quadratic, an arc
 *   in steps of at most 0.2 radians). The stage's bounds, lengths and the
 *   collisions of labels use it.
 * - 'ink': steps so that the polyline stays within FLAT_TOLERANCE of the
 *   curve. Pen ink (ink-points.ts) is sampled along it.
 */

/** Absolute segments: H and V become L, S and T become C and Q with their control points. */
export type PathSegment =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ArcSegment
  | ['Z']

type ArcSegment = ['A', number, number, number, number, number, number, number]

export type Flattening = 'outline' | 'ink'

/** The largest distance between an ink polyline and its curve (board points). */
export const FLAT_TOLERANCE = 0.25
/** At most this many steps for one curve (a curve with very large numbers). */
const MAX_STEPS = 10000

/** Numbers each command reads, per set. */
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
const SPACE = /[\s,]*/y

/**
 * The absolute segments of an SVG path string: every command, absolute and
 * relative, implicit repeats (after M they are L), and compact arc flags
 * ("a5 5 0 1010 10"). An error says what is wrong and where.
 */
export function parsePath(d: string): PathSegment[] {
  const name = `The path "${d.length > 40 ? `${d.slice(0, 40)}…` : d}"`
  const segments: PathSegment[] = []
  let i = 0
  const skip = (): void => {
    SPACE.lastIndex = i
    SPACE.exec(d)
    i = SPACE.lastIndex
  }
  const number = (cmd: string): number => {
    skip()
    NUMBER.lastIndex = i
    const m = NUMBER.exec(d)
    if (!m) {
      const found = i < d.length ? `"${d[i]}" at character ${i + 1}` : 'its end'
      throw new Error(`${name} has a command with too few numbers: ${cmd} needs ${ARGS[cmd.toUpperCase()]} numbers, but the path has ${found}`)
    }
    i = NUMBER.lastIndex
    const value = Number(m[0])
    if (!Number.isFinite(value)) throw new Error(`${name} has a number that is too large at character ${m.index + 1}`)
    return value
  }
  const flag = (): number => {
    skip()
    const c = d[i]
    if (c !== '0' && c !== '1') throw new Error(`${name} has an arc (A) whose large-arc and sweep flags must each be 0 or 1, at character ${i + 1}`)
    i++
    return c === '1' ? 1 : 0
  }
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  /** The control point of the last C/S or Q/T segment, for S and T; null after any other. */
  let cubicCtrl: [number, number] | null = null
  let quadCtrl: [number, number] | null = null
  let cmd = ''
  skip()
  while (i < d.length) {
    const c = d[i]
    if (/[a-zA-Z]/.test(c)) {
      if (!(c.toUpperCase() in ARGS)) throw new Error(`${name} has "${c}" at character ${i + 1}, which is not an SVG path command (M L H V C S Q T A Z)`)
      if (!cmd && c.toUpperCase() !== 'M') throw new Error(`${name} must start with M (a moveto), not "${c}"`)
      cmd = c
      i++
    } else if (!cmd) {
      throw new Error(`${name} must start with M (a moveto)`)
    } else if (cmd.toUpperCase() === 'Z') {
      throw new Error(`${name} has "${c}" at character ${i + 1}, after Z: a new part of the path starts with M`)
    } else if (!/[-+.\d]/.test(c)) {
      throw new Error(`${name} has "${c}" at character ${i + 1}, which is not a path command or a number`)
    }
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    let nextCubic: [number, number] | null = null
    let nextQuad: [number, number] | null = null
    if (C === 'M') {
      cx = number(cmd) + ox
      cy = number(cmd) + oy
      sx = cx
      sy = cy
      segments.push(['M', cx, cy])
      // Numbers after a moveto are linetos.
      cmd = rel ? 'l' : 'L'
    } else if (C === 'L' || C === 'H' || C === 'V') {
      const x = C === 'V' ? cx : number(cmd) + ox
      const y = C === 'H' ? cy : number(cmd) + oy
      cx = x
      cy = y
      segments.push(['L', x, y])
    } else if (C === 'C' || C === 'S') {
      let x1: number
      let y1: number
      if (C === 'C') {
        x1 = number(cmd) + ox
        y1 = number(cmd) + oy
      } else [x1, y1] = cubicCtrl ? [2 * cx - cubicCtrl[0], 2 * cy - cubicCtrl[1]] : [cx, cy]
      const x2 = number(cmd) + ox
      const y2 = number(cmd) + oy
      const x = number(cmd) + ox
      const y = number(cmd) + oy
      segments.push(['C', x1, y1, x2, y2, x, y])
      nextCubic = [x2, y2]
      cx = x
      cy = y
    } else if (C === 'Q' || C === 'T') {
      let x1: number
      let y1: number
      if (C === 'Q') {
        x1 = number(cmd) + ox
        y1 = number(cmd) + oy
      } else [x1, y1] = quadCtrl ? [2 * cx - quadCtrl[0], 2 * cy - quadCtrl[1]] : [cx, cy]
      const x = number(cmd) + ox
      const y = number(cmd) + oy
      segments.push(['Q', x1, y1, x, y])
      nextQuad = [x1, y1]
      cx = x
      cy = y
    } else if (C === 'A') {
      const rx = number(cmd)
      const ry = number(cmd)
      const rotation = number(cmd)
      const large = flag()
      const sweep = flag()
      const x = number(cmd) + ox
      const y = number(cmd) + oy
      segments.push(['A', rx, ry, rotation, large, sweep, x, y])
      cx = x
      cy = y
    } else {
      segments.push(['Z'])
      cx = sx
      cy = sy
    }
    cubicCtrl = nextCubic
    quadCtrl = nextQuad
    skip()
  }
  if (!segments.length) throw new Error(`${name} must start with M (a moveto)`)
  return segments
}

/**
 * Polylines of segments, one per subpath (a closed subpath ends at its start
 * again). A subpath without any drawing command gives no polyline.
 */
export function flattenPath(segments: readonly PathSegment[], mode: Flattening): number[][][] {
  const lines: number[][][] = []
  let line: number[][] | null = null
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const push = (x: number, y: number): void => {
    if (!line) {
      line = [[cx, cy]]
      lines.push(line)
    }
    line.push([x, y])
  }
  for (const s of segments) {
    if (s[0] === 'M') {
      cx = sx = s[1]
      cy = sy = s[2]
      line = null
      continue
    }
    if (s[0] === 'Z') {
      push(sx, sy)
      cx = sx
      cy = sy
      line = null
      continue
    }
    if (s[0] === 'L') push(s[1], s[2])
    else if (s[0] === 'C') {
      const [, x1, y1, x2, y2, x, y] = s
      const n = mode === 'outline' ? 16 : wangSteps(0.75, Math.max(Math.hypot(cx - 2 * x1 + x2, cy - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y)))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        push(u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y)
      }
    } else if (s[0] === 'Q') {
      const [, x1, y1, x, y] = s
      const n = mode === 'outline' ? 12 : wangSteps(0.25, Math.hypot(cx - 2 * x1 + x, cy - 2 * y1 + y))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        push(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y)
      }
    } else arc(s, cx, cy, mode, push)
    cx = s[s.length - 2] as number
    cy = s[s.length - 1] as number
  }
  return lines
}

/** Steps of a Bézier curve so that its polyline stays within FLAT_TOLERANCE (Wang's formula: factor d(d-1)/8, the largest second difference). */
function wangSteps(factor: number, second: number): number {
  const n = Math.ceil(Math.sqrt((factor * second) / FLAT_TOLERANCE))
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_STEPS, n)) : MAX_STEPS
}

/** An elliptical arc from (cx, cy), with the endpoint-to-centre conversion of the SVG specification (F.6.5). */
function arc(s: ArcSegment, cx: number, cy: number, mode: Flattening, push: (x: number, y: number) => void): void {
  let rx = Math.abs(s[1])
  let ry = Math.abs(s[2])
  const phi = (s[3] * Math.PI) / 180
  const large = s[4] !== 0
  const sweep = s[5] !== 0
  const x = s[6]
  const y = s[7]
  if (!rx || !ry) {
    push(x, y)
    return
  }
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (cx - x) / 2
  const dy = (cy - y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const sign = large === sweep ? -1 : 1
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const coef = sign * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)))
  const cxp = (coef * rx * y1) / ry
  const cyp = (-coef * ry * x1) / rx
  const ccx = cos * cxp - sin * cyp + (cx + x) / 2
  const ccy = sin * cxp + cos * cyp + (cy + y) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
  let dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  let n: number
  if (mode === 'outline') n = Math.max(4, Math.ceil(Math.abs(dt) / 0.2))
  else {
    // The chord of an angle step a on radius r is at most r (1 - cos(a / 2)) from the arc.
    const r = Math.max(rx, ry)
    const step = r > FLAT_TOLERANCE ? 2 * Math.acos(1 - FLAT_TOLERANCE / r) : Math.PI / 2
    const steps = Math.ceil(Math.abs(dt) / step)
    n = Number.isFinite(steps) ? Math.max(1, Math.min(MAX_STEPS, steps)) : MAX_STEPS
  }
  for (let k = 1; k <= n; k++) {
    const a = t1 + (dt * k) / n
    push(ccx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, ccy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos)
  }
}
