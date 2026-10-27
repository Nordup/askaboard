/**
 * The points of pen ink along a path: the sampling grid, the split into
 * strokes and the simplification that the board uses for ink with pen: true.
 * DOM-free, so that the stage's worker and the board use the same rules.
 *
 * The stage (stage/worker.ts gives polylineInk to live-prelude.js) makes the
 * final ink points of every pen shape: from its own straight segments (plot,
 * line, arrow, polygon, trace), or from a path flattened by path-geometry.ts
 * (circle, ellipse, rect, an agent's own path).
 */

export type InkXY = [number, number]

/** Kept points are at least this far apart (board points). */
export const INK_STEP = 2.5

/** The number of sampling steps along a path of this length: finer than INK_STEP, simplified later. */
const inkSteps = (total: number): number => Math.max(2, Math.ceil(total / 1.5))

/**
 * The strokes of the points at lengths (total * i) / count, i = 0 … count.
 * A moveto shows as a jump much longer than the sampling step: a new stroke
 * starts there. A stroke of one point is left out. Each stroke keeps its
 * first point, each point at least INK_STEP from the last kept one, and its
 * last point.
 */
function inkRuns(points: readonly InkXY[], total: number, count: number): InkXY[][] {
  const jump = (total / count) * 3 + 0.5
  const out: InkXY[][] = []
  let current: InkXY[] = []
  let last: InkXY | null = null
  for (const point of points) {
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) > jump) {
      if (current.length > 1) out.push(simplify(current))
      current = []
    }
    current.push(point)
    last = point
  }
  if (current.length > 1) out.push(simplify(current))
  return out
}

function simplify(line: InkXY[]): InkXY[] {
  if (line.length < 3) return line
  const out: InkXY[] = [line[0]]
  for (let i = 1; i < line.length - 1; i++) {
    const prev = out[out.length - 1]
    if (Math.hypot(line[i][0] - prev[0], line[i][1] - prev[1]) >= INK_STEP) out.push(line[i])
  }
  out.push(line[line.length - 1])
  return out
}

/**
 * The ink of polylines (one per subpath, as M then L to each next point):
 * the points at the grid lengths along all the subpaths one after the other
 * (a moveto adds no length), found with one walk over the segments, then
 * inkRuns. A length at the end of a subpath gives that end point. A segment
 * whose two ends are the same point in single precision (the board's own
 * precision for paths) has no length. Polylines without length give no ink.
 */
export function polylineInk(lines: readonly (readonly (readonly number[])[])[]): InkXY[][] {
  // The segments with a length, in order: start and end points, and the path length at their start and end.
  const ax: number[] = []
  const ay: number[] = []
  const bx: number[] = []
  const by: number[] = []
  const starts: number[] = []
  const ends: number[] = []
  let total = 0
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1]
      const b = line[k]
      if (Math.fround(a[0]) === Math.fround(b[0]) && Math.fround(a[1]) === Math.fround(b[1])) continue
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (!(total + length > total) || !Number.isFinite(length)) continue
      starts.push(total)
      total += length
      ax.push(a[0])
      ay.push(a[1])
      bx.push(b[0])
      by.push(b[1])
      ends.push(total)
    }
  }
  if (!(total > 0)) return []
  const count = inkSteps(total)
  const n = ends.length
  const points: InkXY[] = new Array(count + 1)
  let s = 0
  for (let i = 0; i <= count; i++) {
    const at = (total * i) / count
    while (s < n - 1 && ends[s] < at) s++
    const t = Math.max(0, Math.min(1, (at - starts[s]) / (ends[s] - starts[s])))
    points[i] = [ax[s] + (bx[s] - ax[s]) * t, ay[s] + (by[s] - ay[s]) * t]
  }
  return inkRuns(points, total, count)
}
