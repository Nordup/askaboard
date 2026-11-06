import type { Point } from './hand'

/**
 * A smooth curve through `pts` (a Catmull-Rom spline, the ends repeated), sampled about every
 * `step` units. A line drawn through a few points then reads as one curve, not as straight
 * pieces; a straight line of two points stays straight, and a line that is already dense keeps
 * its shape.
 */
export function spline(pts: readonly Point[], step = 1.5): Point[] {
  if (pts.length < 3) return pts.slice()
  const out: Point[] = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      const at = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
      out.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  return out
}
