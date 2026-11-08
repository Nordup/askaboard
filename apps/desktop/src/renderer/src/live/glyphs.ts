import type { HandGlyph } from '@shared/hand-font'

/**
 * Letters that write()'s handwriting font lacks (live-prelude.js
 * glyphsFor): the board draws each one with its text font in a light weight
 * and thins it to its centre lines, so write() draws it as one pen line, in
 * the same pen as the letters of its own font. Same units as
 * shared/hand-font.ts: cap height 1, baseline y = 0, +y down; a: advance;
 * s: strokes, each a flat [x, y, …]. Per connected part of the ink: a dot
 * becomes a small pen loop, a filled part (ink much wider than the font's
 * strokes, as in ☗) keeps its outline, a stroke becomes its centre line.
 * The glyph is narrowed to the hand's proportions and gets its side bearings.
 * A letter the font cannot draw at all gives no strokes and its advance.
 */

/** The font size the letters are drawn at, in px. */
const PX = 96
const WEIGHT = 300
/** How far a line may stray from the pixel centre line, in px. */
const TOLERANCE = 1
/** The hand's proportions: narrower than the board font, with its side bearings. */
const NARROW = 0.86
const BEARING = 0.17
const FALLBACK_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif"

type P = [number, number]

/** A glyph's ink as a mask, with the pen origin (baseline left) in mask pixels. */
interface Mask {
  m: Uint8Array
  w: number
  h: number
  x0: number
  y0: number
  width: number
}

function draw(ctx: CanvasRenderingContext2D, font: string, ch: string): Mask {
  const canvas = ctx.canvas
  ctx.font = font
  const metrics = ctx.measureText(ch)
  const pad = 3
  const left = Math.ceil(metrics.actualBoundingBoxLeft)
  const w = Math.max(1, left + Math.ceil(metrics.actualBoundingBoxRight) + pad * 2)
  const h = Math.max(1, Math.ceil(metrics.actualBoundingBoxAscent) + Math.ceil(metrics.actualBoundingBoxDescent) + pad * 2)
  const x0 = pad + left
  const y0 = pad + Math.ceil(metrics.actualBoundingBoxAscent)
  canvas.width = w
  canvas.height = h
  ctx.font = font
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#000'
  ctx.fillText(ch, x0, y0)
  const alpha = ctx.getImageData(0, 0, w, h).data
  // The ink grown by one pixel: thinning wipes out a line only two pixels thick (a hairline of a fallback font).
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (alpha[(y * w + x) * 4 + 3] < 96) continue
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) m[ny * w + nx] = 1
        }
    }
  return { m, w, h, x0, y0, width: metrics.width }
}

const halfWidths = new Map<string, number>()

export function traceGlyphs(chars: string[]): Record<string, HandGlyph> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out: Record<string, HandGlyph> = {}
  if (!ctx) return out
  const content = document.querySelector('.board__content')
  const family = (content ? getComputedStyle(content).getPropertyValue('--ls-font').trim() : '') || FALLBACK_FONT
  const font = `${WEIGHT} ${PX}px ${family}`
  ctx.font = font
  const cap = ctx.measureText('H').actualBoundingBoxAscent || PX * 0.7
  // Half the stroke width of the light board font, from its letter I: ink wider than twice this is a filled part.
  let half = halfWidths.get(font)
  if (half === undefined) {
    const I = draw(ctx, font, 'I')
    const skel = thin(I.m, I.w, I.h)
    half = median(distances(I.m, I.w, I.h), skel) || 2
    halfWidths.set(font, half)
  }
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  for (const ch of chars) {
    const g = draw(ctx, font, ch)
    const lines: P[][] = []
    for (const part of parts(g.m, g.w, g.h)) lines.push(...partLines(part, g.w, g.h, cap, half))
    const px = lines.flat()
    if (!px.length) {
      out[ch] = { a: r3(g.width / cap), s: [] }
      continue
    }
    const units = lines.map((l) => l.map(([x, y]): P => [(x - g.x0) / cap, (y - g.y0) / cap]))
    let lo = Infinity
    let hi = -Infinity
    for (const [x] of units.flat()) {
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    out[ch] = {
      a: r3((hi - lo) * NARROW + 2 * BEARING + 0.06),
      s: units.map((l) => l.flatMap(([x, y]) => [r3(BEARING + (x - lo) * NARROW), r3(y)]))
    }
  }
  return out
}

/** The pen lines of one connected part of the ink, in mask pixels. */
function partLines(part: Uint8Array, w: number, h: number, cap: number, half: number): P[][] {
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < part.length; i++) {
    if (!part[i]) continue
    const x = i % w
    const y = (i - x) / w
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
    sx += x
    sy += y
    n++
  }
  const dotLoop = (): P[][] => {
    const r = 0.035 * cap
    const cx = sx / n + 0.5
    const cy = sy / n + 0.5
    return [Array.from({ length: 13 }, (_, k): P => [cx + r * Math.cos((k / 6) * Math.PI), cy + r * Math.sin((k / 6) * Math.PI)])]
  }
  // A dot is about as wide as the font's strokes are thick; a short stroke (the arms of א) is longer.
  if (Math.max(x1 - x0, y1 - y0) + 1 < Math.min(0.2 * cap, 3 * half)) return dotLoop()
  const skel = thin(part, w, h)
  if (median(distances(part, w, h), skel) > 2 * half) {
    return contours(part, w, h)
      .map((loop) => simplify(loop, TOLERANCE))
      .filter((loop) => loop.length >= 3)
  }
  const lines = centreLines(skel, w, h, cap)
  return lines.length ? lines.map((l) => simplify(l, TOLERANCE)) : dotLoop()
}

/** The 8-connected parts of a mask, each as its own mask. */
function parts(mask: Uint8Array, w: number, h: number): Uint8Array[] {
  const seen = new Uint8Array(mask.length)
  const out: Uint8Array[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const part = new Uint8Array(mask.length)
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop() as number
      part[i] = 1
      const x = i % w
      const y = (i - x) / w
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (mask[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
    }
    out.push(part)
  }
  return out
}

/** The 8 neighbours of pixel i, clockwise from north (P2 … P9 of Zhang–Suen). */
function ring(m: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w
  const y = (i - x) / w
  const at = (dx: number, dy: number): number => {
    const nx = x + dx
    const ny = y + dy
    return nx >= 0 && ny >= 0 && nx < w && ny < h ? m[ny * w + nx] : 0
  }
  return [at(0, -1), at(1, -1), at(1, 0), at(1, 1), at(0, 1), at(-1, 1), at(-1, 0), at(-1, -1)]
}

/**
 * Zhang–Suen thinning to one-pixel lines, then the pixels that only thicken
 * a line go (the staircase corners), so a diagonal line or a ring has no
 * false junctions.
 */
function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = mask.slice()
  let ink: number[] = []
  for (let i = 0; i < m.length; i++) if (m[i]) ink.push(i)
  let changed = true
  while (changed) {
    changed = false
    for (const pass of [0, 1]) {
      const drop: number[] = []
      for (const i of ink) {
        const p = ring(m, w, h, i)
        const b = p.reduce((s, v) => s + v, 0)
        if (b < 2 || b > 6) continue
        let a = 0
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++
        if (a !== 1) continue
        const [n, , e, , s, , west] = p
        if (pass === 0 ? n * e * s === 0 && e * s * west === 0 : n * e * west === 0 && n * s * west === 0) drop.push(i)
      }
      for (const i of drop) m[i] = 0
      if (drop.length) {
        changed = true
        ink = ink.filter((i) => m[i])
      }
    }
  }
  // A pixel whose neighbours touch each other without it adds nothing to the line: it goes, unless it is a line end.
  for (let again = true; again; ) {
    again = false
    for (const i of ink) {
      if (!m[i]) continue
      const p = ring(m, w, h, i)
      if (p.reduce((s, v) => s + v, 0) >= 2 && neighbourGroups(p) === 1) {
        m[i] = 0
        again = true
      }
    }
  }
  return m
}

/**
 * How many groups the set neighbours of a pixel form among themselves (ring
 * from north, clockwise). Ring neighbours touch; so do two orthogonal ones
 * at a right angle (N and E touch at the corner).
 */
function neighbourGroups(p: number[]): number {
  const group = [0, 1, 2, 3, 4, 5, 6, 7]
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])))
  for (let k = 0; k < 8; k++) {
    if (!p[k]) continue
    if (p[(k + 1) % 8]) group[find(k)] = find((k + 1) % 8)
    if (k % 2 === 0 && p[(k + 2) % 8]) group[find(k)] = find((k + 2) % 8)
  }
  const roots = new Set<number>()
  for (let k = 0; k < 8; k++) if (p[k]) roots.add(find(k))
  return roots.size
}

/** Distance of each ink pixel to the nearest background pixel (chamfer 1, √2). */
function distances(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(mask.length)
  const BIG = 1e6
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0
  const at = (x: number, y: number): number => (x >= 0 && y >= 0 && x < w && y < h ? d[y * w + x] : 0)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + Math.SQRT2, at(x + 1, y - 1) + Math.SQRT2)
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + Math.SQRT2, at(x - 1, y + 1) + Math.SQRT2)
    }
  return d
}

function median(values: Float32Array, where: Uint8Array): number {
  const got: number[] = []
  for (let i = 0; i < where.length; i++) if (where[i]) got.push(values[i])
  if (!got.length) return 0
  got.sort((a, b) => a - b)
  return got[got.length >> 1]
}

/**
 * The lines of a one-pixel skeleton: walk from the line ends first, then
 * from the junctions, then around closed loops. Short spurs go, and two
 * lines whose ends meet and run on in about the same direction become one.
 */
function centreLines(skel: Uint8Array, w: number, h: number, cap: number): P[][] {
  const nb = (i: number): number[] => {
    const x = i % w
    const y = (i - x) / w
    const out: number[] = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) out.push(ny * w + nx)
      }
    return out
  }
  const pixels: number[] = []
  for (let i = 0; i < skel.length; i++) if (skel[i]) pixels.push(i)
  const degree = new Map(pixels.map((i) => [i, nb(i).length]))
  const rank = (i: number): number => {
    const d = degree.get(i) ?? 0
    return d === 1 ? 0 : d >= 3 ? 1 : 2
  }
  pixels.sort((a, b) => rank(a) - rank(b) || a - b)
  const used = new Set<number>()
  const edge = (a: number, b: number): number => Math.min(a, b) * skel.length + Math.max(a, b)
  const walks: number[][] = []
  for (const start of pixels) {
    for (const first of nb(start)) {
      if (used.has(edge(start, first))) continue
      used.add(edge(start, first))
      const walk = [start, first]
      let cur = first
      while (degree.get(cur) === 2) {
        const next = nb(cur).find((q) => !used.has(edge(cur, q)))
        if (next === undefined) break
        used.add(edge(cur, next))
        walk.push(next)
        cur = next
      }
      walks.push(walk)
    }
  }
  let lines: P[][] = walks.map((walk) => walk.map((i): P => [(i % w) + 0.5, Math.floor(i / w) + 0.5]))
  const length = (l: P[]): number => l.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - l[k][0], p[1] - l[k][1]), 0)
  if (lines.length > 1) lines = lines.filter((l) => length(l) >= 0.07 * cap)
  // The outward direction at a line's end (or start).
  const out = (l: P[], atEnd: boolean): P => {
    const a = atEnd ? l[Math.max(0, l.length - 6)] : l[Math.min(l.length - 1, 5)]
    const b = atEnd ? l[l.length - 1] : l[0]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
  }
  let joined = true
  while (joined) {
    joined = false
    search: for (let i = 0; i < lines.length; i++)
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue
        const a = lines[i]
        for (const b of [lines[j], [...lines[j]].reverse()]) {
          const ea = a[a.length - 1]
          const sb = b[0]
          const da = out(a, true)
          const db = out(b, false)
          if (Math.hypot(ea[0] - sb[0], ea[1] - sb[1]) <= 4 && -(da[0] * db[0] + da[1] * db[1]) > 0.6) {
            lines[i] = [...a, ...b]
            lines.splice(j, 1)
            joined = true
            break search
          }
        }
      }
  }
  return lines
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
      // Sample (x, y) is the centre of pixel x, y: edge points in pixel coordinates are offset by half a pixel.
      const edge = (e: string): P => (e === 'T' ? [x + 1, y + 0.5] : e === 'R' ? [x + 1.5, y + 1] : e === 'B' ? [x + 1, y + 1.5] : [x + 0.5, y + 1])
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
