import type { InkPoint } from '@shared/board-format'
import { INK_STEP } from '@shared/ink-points'
import type { Point } from './types'

/**
 * Ink that looks drawn by hand: a slight wobble and, for pen ink, a pressure
 * profile with a taper at both ends. Live scenes draw their pen ink with it
 * (the stage makes the points of pen shapes, shared/ink-points.ts), and the
 * learner's shapes get their even line from it (shapes.ts), so both have one hand.
 */

/**
 * A 32-bit seed from a stroke's key and its points (FNV-1a over the key and
 * the points to 0.01 board point). The same stroke of the same scene gets
 * the same seed in each compile.
 */
export function strokeSeed(key: string, line: readonly Point[]): number {
  let h = 0x811c9dc5
  const add = (value: number): void => {
    h ^= value & 0xffff
    h = Math.imul(h, 0x01000193)
    h ^= (value >>> 16) & 0xffff
    h = Math.imul(h, 0x01000193)
  }
  for (let i = 0; i < key.length; i++) add(key.charCodeAt(i))
  for (const [x, y] of line) {
    add(Math.round(x * 100) | 0)
    add(Math.round(y * 100) | 0)
  }
  return h >>> 0
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
 * The hand's sideways wobble: two sine waves along the line's length, the
 * first 0.7 and the second 0.3 of `amplitude` (board points), with periods
 * of 2π × `waves` board points.
 */
export interface Wobble {
  amplitude: number
  waves: readonly [number, number]
}

/** The wobble of pen ink at jitter 1 (humanize scales it by its jitter). */
const PEN_WOBBLE: Wobble = { amplitude: 2.2, waves: [23, 7.3] }

/**
 * A polyline with the hand's wobble, as `[x, y, s]`: s is the length along
 * the line before the wobble. `random` gives the phases (two draws).
 */
function wobbled(line: Point[], wobble: Wobble, random: () => number): [number, number, number][] {
  const dense = densify(line, INK_STEP)
  const phase = [random() * Math.PI * 2, random() * Math.PI * 2]
  let s = 0
  return dense.map((point, i) => {
    if (i > 0) s += Math.hypot(point[0] - dense[i - 1][0], point[1] - dense[i - 1][1])
    // Sideways direction: the normal of the local segment.
    const a = dense[Math.max(0, i - 1)]
    const b = dense[Math.min(dense.length - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / len
    const ny = (b[0] - a[0]) / len
    const offset = wobble.amplitude * (0.7 * Math.sin(s / wobble.waves[0] + phase[0]) + 0.3 * Math.sin(s / wobble.waves[1] + phase[1]))
    return [point[0] + nx * offset, point[1] + ny * offset, s]
  })
}

/**
 * A polyline with the hand's wobble and an even width (pressure 0.5, which
 * paints at the nominal width): the line of the learner's shapes (shapes.ts)
 * and of the agents' pen shapes (live/compile.ts handPath).
 */
export function handLine(line: Point[], wobble: Wobble, random: () => number): InkPoint[] {
  return wobbled(line, wobble, random).map(([x, y]) => [x, y, 0.5])
}

/** The pen wobble at `jitter` (0..1), for handLine. */
export function penWobble(jitter: number): Wobble {
  return { ...PEN_WOBBLE, amplitude: Math.max(0, Math.min(1, jitter)) * PEN_WOBBLE.amplitude }
}

/**
 * Make a polyline look hand-drawn as pen ink: the pen wobble scaled by
 * `jitter` (0..1), and pressure that rises at the start, varies a little and
 * falls at the end. `random` gives the wobble's phases: give a seeded source
 * (mulberry32, shared/live-scene.ts), so the same stroke looks the same each time.
 */
export function humanize(line: Point[], jitter: number, random: () => number): InkPoint[] {
  const points = wobbled(line, penWobble(jitter), random)
  const total = points.length ? points[points.length - 1][2] || 1 : 1
  const taper = Math.min(18, total * 0.18)
  // The third phase and the base after the wobble's two: the same stroke keeps its look.
  const phase = random() * Math.PI * 2
  const base = 0.5 + random() * 0.1
  return points.map(([x, y, s]) => {
    const rise = Math.min(1, s / Math.max(1, taper))
    const fall = Math.min(1, (total - s) / Math.max(1, taper * 1.4))
    const ends = 0.25 + 0.75 * Math.min(rise, fall)
    const pressure = Math.max(0.08, Math.min(1, base * ends + 0.05 * Math.sin(s / 31 + phase)))
    return [x, y, Math.round(pressure * 100) / 100]
  })
}
