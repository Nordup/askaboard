import type { HandGlyph } from '@shared/hand-font'

/**
 * Characters that write()'s handwriting font lacks (live-prelude.js
 * glyphsFor): the board draws each one with its text font and traces the
 * outlines of its shape, so write() draws it as pen strokes, as it draws the
 * letters of its own font. Same units as shared/hand-font.ts: cap height 1,
 * baseline y = 0, +y down; a: advance; s: strokes, each a flat [x, y, …].
 * A character the font cannot draw at all gives no strokes and its advance.
 */

/** The font size the outlines are traced at, in px. */
const PX = 96
/** How far a traced outline may stray from the pixel outline, in px. */
const TOLERANCE = 0.7
const FALLBACK_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif"

type P = [number, number]

export function traceGlyphs(chars: string[]): Record<string, HandGlyph> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out: Record<string, HandGlyph> = {}
  if (!ctx) return out
  const content = document.querySelector('.board__content')
  const family = (content ? getComputedStyle(content).getPropertyValue('--ls-font').trim() : '') || FALLBACK_FONT
  const font = `${PX}px ${family}`
  ctx.font = font
  const cap = ctx.measureText('H').actualBoundingBoxAscent || PX * 0.7
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  for (const ch of chars) {
    ctx.font = font
    const m = ctx.measureText(ch)
    const pad = 2
    const left = Math.ceil(m.actualBoundingBoxLeft)
    const w = Math.max(1, left + Math.ceil(m.actualBoundingBoxRight) + pad * 2)
    const h = Math.max(1, Math.ceil(m.actualBoundingBoxAscent) + Math.ceil(m.actualBoundingBoxDescent) + pad * 2)
    const x0 = pad + left
    const y0 = pad + Math.ceil(m.actualBoundingBoxAscent)
    canvas.width = w
    canvas.height = h
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#000'
    ctx.fillText(ch, x0, y0)
    const alpha = ctx.getImageData(0, 0, w, h).data
    const mask = new Uint8Array(w * h)
    for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3] >= 128 ? 1 : 0
    const strokes = contours(mask, w, h)
      .map((loop) => simplify(loop, TOLERANCE))
      .filter((loop) => loop.length >= 3)
      .map((loop) => loop.flatMap(([x, y]) => [r3((x - x0) / cap), r3((y - y0) / cap)]))
    out[ch] = { a: r3(m.width / cap), s: strokes }
  }
  return out
}

/**
 * The outlines of a mask (marching squares): closed loops through the
 * midpoints of the edges between inside and outside samples. A loop ends
 * where it started.
 */
function contours(mask: Uint8Array, w: number, h: number): P[][] {
  const at = (x: number, y: number): number => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0)
  const segments: Array<[P, P]> = []
  // Each case: the pairs of cell edges a segment joins (T top, R right, B bottom, L left); saddles cut off the inside corners.
  const CASES: Record<number, Array<[string, string]>> = {
    1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']], 5: [['T', 'R'], ['L', 'B']], 6: [['T', 'B']], 7: [['T', 'L']],
    8: [['T', 'L']], 9: [['T', 'B']], 10: [['T', 'L'], ['B', 'R']], 11: [['T', 'R']], 12: [['L', 'R']], 13: [['R', 'B']], 14: [['L', 'B']]
  }
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const code = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1)
      const pairs = CASES[code]
      if (!pairs) continue
      const edge = (e: string): P => (e === 'T' ? [x + 0.5, y] : e === 'R' ? [x + 1, y + 0.5] : e === 'B' ? [x + 0.5, y + 1] : [x, y + 0.5])
      for (const [a, b] of pairs) segments.push([edge(a), edge(b)])
    }
  }
  // Every edge point belongs to two segments: walk from segment to segment until the loop closes.
  const key = (p: P): string => `${p[0] * 2},${p[1] * 2}`
  const byPoint = new Map<string, number[]>()
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const list = byPoint.get(key(p))
      if (list) list.push(i)
      else byPoint.set(key(p), [i])
    }
  })
  const used = new Uint8Array(segments.length)
  const loops: P[][] = []
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue
    used[start] = 1
    const loop: P[] = [segments[start][0], segments[start][1]]
    let tail = segments[start][1]
    for (;;) {
      const next = (byPoint.get(key(tail)) ?? []).find((i) => !used[i])
      if (next === undefined) break
      used[next] = 1
      const [a, b] = segments[next]
      tail = key(a) === key(tail) ? b : a
      loop.push(tail)
    }
    loops.push(loop)
  }
  return loops
}

/** Douglas–Peucker: the fewest points within `tolerance` of the line; the ends stay. */
function simplify(points: P[], tolerance: number): P[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  // A closed loop's ends are one point: split it at its farthest point first.
  let far = 0
  let best = -1
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1])
    if (d > best) {
      best = d
      far = i
    }
  }
  if (far > 0) {
    keep[far] = 1
    stack[0] = [0, far]
    stack.push([far, points.length - 1])
  }
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number]
    const [ax, ay] = points[i]
    const [bx, by] = points[j]
    const len = Math.hypot(bx - ax, by - ay)
    let worst = -1
    let index = -1
    for (let k = i + 1; k < j; k++) {
      const [px, py] = points[k]
      const d = len > 1e-9 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay)
      if (d > worst) {
        worst = d
        index = k
      }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1
      stack.push([i, index], [index, j])
    }
  }
  return points.filter((_, i) => keep[i])
}
