/**
 * The learner's handwriting for a council run: text → pen strokes in board
 * points, from the app's own stroke font (src/shared/hand-font.ts), with a
 * little per-letter and per-stroke variation so it reads as a person's hand.
 *
 *   learnerText('3 ÷ 1/2 = 1.5\nIs this right?', { x, y, size }) → [[[x, y, p], …], …]
 *
 * (x, y) is the top-left of the first line; size is the cap height. Lines
 * split at "\n" (a real newline or the two characters). A token a/b with no
 * spaces (1/2, x/3) is written as a stacked fraction; "1 / 2" keeps the slash.
 * The variation is seeded by the text, so the same text gives the same ink.
 */
import { readFileSync } from 'node:fs'

// The font is a TypeScript module of plain data: read its object literal (no type stripping, no warning).
const FONT_FILE = new URL('../../src/shared/hand-font.ts', import.meta.url)
const HAND_FONT = new Function(`return ${readFileSync(FONT_FILE, 'utf8').split(/HAND_FONT[^=]*=/)[1]}`)()

const SPACE_ADVANCE = 0.45 // in cap heights
const TIGHTEN = 0.8 // a hand writes closer than the font's side bearings
const LINE_GAP = 1.9 // line pitch in cap heights
const FRACTION = 0.72 // numerator and denominator size
const AXIS = -0.43 // the maths axis (the bar of + and −), font units

/** A small seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (text) => [...text].reduce((h, c) => Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0, 2166136261)

function glyph(char) {
  let g = HAND_FONT[char]
  for (let i = 0; typeof g === 'string' && i < 4; i++) g = HAND_FONT[g]
  if (!g || typeof g === 'string') {
    // Common keyboard stand-ins for the maths signs.
    const stand = { '*': '×', ':': '÷' }[char]
    if (stand && stand !== char) return glyph(stand)
    throw new Error(`--learner-text: the hand font has no "${char}"`)
  }
  return g
}

/** Ink bounds in x of a glyph (font units). */
function inkX(g) {
  const xs = g.s.flatMap((s) => s.filter((_, i) => i % 2 === 0))
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, g.a]
}

/**
 * Lay a run of characters out in "pen space": strokes as [[x, y], …] in cap-height
 * units with the baseline at y = 0, starting at x0. Returns { strokes, width }.
 * scale shrinks the letters (fractions); dy moves the baseline.
 */
function layRun(text, x0, rand, scale = 1, dy = 0) {
  const letters = []
  let x = x0
  for (const char of text) {
    if (char === ' ') {
      x += SPACE_ADVANCE * scale * (0.85 + 0.3 * rand())
      continue
    }
    const g = glyph(char)
    const [lo, hi] = inkX(g)
    const inkW = hi - lo
    const side = Math.min(0.2, Math.max(0.08, ((g.a - inkW) / 2) * TIGHTEN * 0.55))
    // Per letter: size, slant, a little rotation and a baseline shift.
    const s = scale * (0.94 + 0.12 * rand())
    const slant = 0.1 + (rand() - 0.5) * 0.08
    const rot = ((rand() - 0.5) * 5 * Math.PI) / 180
    const base = dy + (rand() - 0.5) * 0.06 * scale
    const left = x + side * scale - lo * s
    const cx = (lo + hi) / 2
    const strokes = g.s.map((flat) => {
      const pts = []
      for (let i = 0; i < flat.length; i += 2) {
        // Rotate about the glyph's middle, then slant (shear by height).
        const gx = flat[i] - cx
        const gy = flat[i + 1] - AXIS
        const rx = gx * Math.cos(rot) - gy * Math.sin(rot)
        const ry = gx * Math.sin(rot) + gy * Math.cos(rot) + AXIS
        pts.push([left + (rx + cx) * s - ry * s * slant, base + ry * s])
      }
      return pts
    })
    letters.push(strokes)
    x = left + hi * s + side * scale + (rand() - 0.5) * 0.04 * scale
  }
  return { strokes: letters.flat(), width: x - x0 }
}

/** Points along a polyline every `step`, with a smooth sideways wobble and a small shift. */
function handStroke(points, step, wobble, rand) {
  const out = []
  const shift = [(rand() - 0.5) * wobble * 2, (rand() - 0.5) * wobble * 2]
  const phase = rand() * Math.PI * 2
  const freq = 0.6 + rand() * 0.8
  let along = 0
  const push = (x, y, nx, ny) => {
    const w = Math.sin(phase + along * freq) * wobble
    out.push([x + shift[0] + nx * w, y + shift[1] + ny * w])
  }
  if (points.length === 1) points = [points[0], points[0]]
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[i + 1]
    const len = Math.hypot(x2 - x1, y2 - y1)
    const nx = len ? -(y2 - y1) / len : 0
    const ny = len ? (x2 - x1) / len : 0
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      push(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n, nx, ny)
      if (k < n) along += len / n
    }
  }
  return out
}

/** Split a line into plain runs and stacked fractions. */
function tokens(line) {
  const parts = []
  const re = /(?<![^\s(=+\-−×÷])([0-9A-Za-z.]+)\/([0-9A-Za-z.]+)(?![^\s)=+\-−×÷?.,])/g
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index) })
    parts.push({ num: m[1], den: m[2] })
    last = m.index + m[0].length
  }
  if (last < line.length) parts.push({ text: line.slice(last) })
  return parts
}

export function learnerText(text, { x = -320, y = -80, size = 36 } = {}) {
  const rand = rng(hash(text))
  const lines = text.split(/\\n|\n/)
  const all = []
  lines.forEach((line, li) => {
    const pen = [] // strokes in cap-height units, baseline 0
    let cx = (rand() - 0.5) * 0.3 // a line does not start at the same x
    for (const part of tokens(line)) {
      if (part.text !== undefined) {
        const run = layRun(part.text, cx, rand)
        pen.push(...run.strokes)
        cx += run.width
        continue
      }
      // A stacked fraction: numerator over a bar over the denominator, centred.
      const gap = 0.16
      const num = layRun(part.num, 0, rand, FRACTION, AXIS - gap)
      const den = layRun(part.den, 0, rand, FRACTION, AXIS + gap + FRACTION)
      const w = Math.max(num.width, den.width) + 0.15
      const x0 = cx + 0.08
      const place = (run) => pen.push(...run.strokes.map((s) => s.map(([px, py]) => [px + x0 + (w - run.width) / 2, py])))
      place(num)
      pen.push([
        [x0, AXIS + (rand() - 0.5) * 0.04],
        [x0 + w, AXIS + (rand() - 0.5) * 0.06]
      ])
      place(den)
      cx = x0 + w + 0.12
    }
    // The line's baseline drifts a little; board points from here.
    const tilt = ((rand() - 0.5) * 2 * Math.PI) / 180
    const baseY = y + size + li * LINE_GAP * size
    for (const stroke of pen) {
      const pts = stroke.map(([px, py]) => [x + px * size, baseY + py * size + px * size * tilt])
      const hand = handStroke(pts, size / 9, size * 0.014, rand)
      const p0 = 0.48 + rand() * 0.14
      all.push(hand.map(([hx, hy], i) => [Math.round(hx * 10) / 10, Math.round(hy * 10) / 10, Math.round((p0 + 0.05 * Math.sin(i / 3)) * 100) / 100]))
    }
  })
  return all
}
