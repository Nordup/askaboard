// Copied from apps/desktop/src/renderer/src/board/hand.ts (humanize, strokeSeed; only the imports changed).
import { INK_STEP } from './ink-points'

export type Point = [number, number]
export type InkPoint = [x: number, y: number, pressure: number]

/**
 * Ink that looks drawn by hand: a pressure profile with a taper at both ends
 * and a slight wobble. Live scenes draw their pen ink with it (the stage makes
 * the points of pen shapes, shared/ink-points.ts), and the learner's shapes
 * get their strokes from it (shapes.ts), so both have one hand.
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
 * Make a polyline look hand-drawn: a low-frequency sideways wobble scaled by
 * `jitter` (0..1), and pressure that rises at the start, varies a little and
 * falls at the end. `random` gives the wobble's phases: give a seeded source
 * (mulberry32, shared/live-scene.ts), so the same stroke looks the same each time.
 */
export function humanize(line: Point[], jitter: number, random: () => number): InkPoint[] {
  const dense = densify(line, INK_STEP)
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
