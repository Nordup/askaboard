/**
 * The outlines of the pen shapes: how the scene library (stage/live-prelude.js circle, ellipse, rect,
 * arrow; stage/worker.ts hands these functions over) builds a shape's path, and how the learner's
 * shapes (renderer board/shapes.ts) and the ink glyphs (components/InkGlyph.tsx) build theirs. One
 * source, so all of them draw the same outline (docs/learning-space/agent-ink.md). DOM-free.
 */

import type { PathSegment } from './path-geometry'

/** A number to 0.01: the precision of the paths a scene writes. */
export const f2 = (v: number): number => Math.round(v * 100) / 100

/** An ellipse as four cubic arcs (absolute segments), starting at the left (a hand starts circles there). */
export function ellipseSegments(cx: number, cy: number, rx: number, ry: number): PathSegment[] {
  const k = 0.5522847498
  const p = (x: number, y: number): [number, number] => [f2(x), f2(y)]
  return [
    ['M', ...p(cx - rx, cy)],
    ['C', ...p(cx - rx, cy + ry * k), ...p(cx - rx * k, cy + ry), ...p(cx, cy + ry)],
    ['C', ...p(cx + rx * k, cy + ry), ...p(cx + rx, cy + ry * k), ...p(cx + rx, cy)],
    ['C', ...p(cx + rx, cy - ry * k), ...p(cx + rx * k, cy - ry), ...p(cx, cy - ry)],
    ['C', ...p(cx - rx * k, cy - ry), ...p(cx - rx, cy - ry * k), ...p(cx - rx, cy)],
    ['Z']
  ]
}

/**
 * A rectangle x, y, w × h with corners of radius r (the caller keeps r within half of each side), as
 * absolute segments. With r > 0 it starts at (x + r, y) on the top side and goes clockwise with an arc
 * at each corner; with r = 0 it starts at the top-left corner.
 */
export function rectSegments(x: number, y: number, w: number, h: number, r: number): PathSegment[] {
  const [x0, y0, x1, y1] = [f2(x), f2(y), f2(x + w), f2(y + h)]
  if (!(r > 0)) return [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']]
  const [xr, yr, xw, yh] = [f2(x + r), f2(y + r), f2(x + w - r), f2(y + h - r)]
  const corner = (ex: number, ey: number): PathSegment => ['A', r, r, 0, 0, 1, ex, ey]
  return [['M', xr, y0], ['L', xw, y0], corner(x1, yr), ['L', x1, yh], corner(xw, y1), ['L', xr, y1], corner(x0, yh), ['L', x0, yr], corner(xr, y0), ['Z']]
}

/** The length of an arrowhead's wings on an arrow of this length and line width, when the scene gives none. */
export function arrowHead(length: number, width: number): number {
  return Math.max(10, Math.min(22, length * 0.2, width * 5))
}

/** The ends of the two wings of an arrowhead of size `head` at (x2, y2), on a line from (x1, y1): each 0.45 radians off the line. */
export function arrowWings(x1: number, y1: number, x2: number, y2: number, head: number): [[number, number], [number, number]] {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / length
  const uy = (y2 - y1) / length
  const wing = (angle: number): [number, number] => {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return [x2 - head * (ux * c - uy * s), y2 - head * (uy * c + ux * s)]
  }
  return [wing(0.45), wing(-0.45)]
}
