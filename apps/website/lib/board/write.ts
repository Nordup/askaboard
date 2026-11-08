// @ts-nocheck -- copied JavaScript, kept as written.
// Copied from apps/desktop/src/stage/live-prelude.js (handwriting: shapeText, letters, compose, handGlyphs, write; boundsOfPoints).
// Changed only to run outside the stage: the shims below stand for the prelude's own helpers, glyphsFor skips letters
// the font lacks (no board fallback), and write() returns its ink (lines, width, speed, jitter) instead of a scene object.
import { HAND_FONT } from './hand-font'
import { seeded } from './random'

const FONT = HAND_FONT
let rng = seeded(7)
const building = 0
const fail = (message) => {
  throw new Error(message)
}
const num = (value) => value
const describe = (value) => String(value)
const options = (opts) => opts || {}
const pointArg = (p) => p
const inkObject = (_api, lines, opts, defaults) => ({ lines, color: opts.color ?? 'text', width: opts.width ?? defaults.width, speed: defaults.speed, jitter: opts.jitter ?? defaults.jitter })

function boundsOfPoints(list) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of list) {
    if (p[0] < x0) x0 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[0] > x1) x1 = p[0]
    if (p[1] > y1) y1 = p[1]
  }
  if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// ---------- Handwriting ----------

const SUPERS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '−', 'ⁿ': 'n', 'ˣ': 'x' }
const SUBS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '−', 'ₓ': 'x', 'ᵢ': 'i', 'ₙ': 'n' }

/** Characters with a level: 0 normal, 1 superscript, -1 subscript. "^2", "^{10}", "_1", "_{ab}" and ²₁ work. */
function shapeText(source) {
  // By letters, not UTF-16 units: a character outside the BMP (𝔽, an emoji) is one letter, and so is a letter
  // with its combining accents (x̄). Every kind of space is a space.
  const text = letters(source.normalize('NFC').replace(/[^\S\n]/g, ' '))
  const out = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if ((c === '^' || c === '_') && i + 1 < text.length && text[i + 1] !== ' ') {
      const level = c === '^' ? 1 : -1
      if (text[i + 1] === '{') {
        const close = text.indexOf('}', i + 2)
        const end = close < 0 ? text.length : close
        for (const ch of text.slice(i + 2, end)) out.push([ch, level])
        i = end
      } else {
        out.push([text[i + 1], level])
        i++
      }
      continue
    }
    if (SUPERS[c]) out.push([SUPERS[c], 1])
    else if (SUBS[c]) out.push([SUBS[c], -1])
    else out.push([c, 0])
  }
  return out
}

/** A string as letters: each character with the combining marks that follow it. */
const MARK = /\p{M}/u
function letters(text) {
  const out = []
  for (const ch of text) {
    if (out.length && MARK.test(ch)) out[out.length - 1] += ch
    else out.push(ch)
  }
  return out
}

/** A glyph of the handwriting font itself (an alias names the character whose glyph it shares). */
function fontGlyph(ch) {
  const g = FONT[ch]
  return typeof g === 'string' ? FONT[g] || null : g || null
}

// Accents: the font holds each combining mark (U+0300…) drawn over a lower-case letter or hanging from the
// baseline, centred on x = 0. compose() puts the marks on the base letter in the same pen.
const BELOW = new Set(['\u0323', '\u0326', '\u0327', '\u0328'])
const DOTLESS = { i: 'ı', j: 'ȷ', 'і': 'ı', 'ј': 'ȷ' }
const CARON_AS_APOSTROPHE = new Set(['d', 't', 'l', 'L'])
const XHEIGHT = 0.667
function inkBox(strokes) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const s of strokes)
    for (let k = 0; k < s.length; k += 2) {
      x0 = Math.min(x0, s[k]); x1 = Math.max(x1, s[k])
      y0 = Math.min(y0, s[k + 1]); y1 = Math.max(y1, s[k + 1])
    }
  return { x0, x1, y0, y1 }
}
const moved = (strokes, dx, dy) => strokes.map((s) => s.map((v, k) => (k % 2 ? v + dy : v + dx)))
function compose(letter) {
  const [base, ...marks] = Array.from(letter.normalize('NFD'))
  if (!marks.length || !marks.every((m) => MARK.test(m) && fontGlyph(m))) return null
  const above = marks.some((m) => !BELOW.has(m))
  const glyph = fontGlyph((above && DOTLESS[base]) || base)
  if (!glyph) return null
  const box = inkBox(glyph.s)
  const strokes = [...glyph.s]
  let a = glyph.a
  let top = box.y0
  for (const m of marks) {
    if (m === '\u030C' && CARON_AS_APOSTROPHE.has(base)) {
      // ď ť ľ Ľ: the caron of a tall letter is a small apostrophe after it.
      const tick = fontGlyph("'").s
      strokes.push(...moved(tick, box.x1 - 0.1, box.y0 + 1))
      a += 0.14
      continue
    }
    const mark = fontGlyph(m).s
    if (BELOW.has(m)) {
      // An ogonek hangs from the right foot, the others from the middle of the baseline.
      strokes.push(...moved(mark, m === '\u0328' ? box.x1 - 0.1 : (box.x0 + box.x1) / 2, Math.max(0, box.y1)))
      continue
    }
    // Over a capital or a tall letter the mark sits a little closer, and a second mark stacks on the first.
    const dy = top + XHEIGHT + (top < -0.75 ? 0.05 : 0)
    const placed = moved(mark, (box.x0 + box.x1) / 2, dy)
    strokes.push(...placed)
    top = inkBox(placed).y0 - 0.1
  }
  return { a, s: strokes }
}

/**
 * The glyphs of one letter in the handwriting font, or null: the font's own glyph, else the letter's base letter
 * with its accents, else its compatibility form (𝐱 → x, Ⅱ → II, ﬁ → fi, ℃ → °C), which can be several glyphs.
 */
const handCache = new Map()
function handGlyphs(letter) {
  if (handCache.has(letter)) return handCache.get(letter)
  const own = (l) => fontGlyph(l) || compose(l)
  let got = own(letter) ? [own(letter)] : null
  if (!got) {
    const form = letter.normalize('NFKD')
    if (form !== letter && form.trim() === form) {
      const parts = letters(form.normalize('NFC')).map(own)
      if (parts.length && parts.every(Boolean)) got = parts
    }
  }
  handCache.set(letter, got)
  return got
}

/** The glyphs of each letter for write(): the handwriting font (handGlyphs); a letter the font lacks is left out. */
function glyphsFor(chars) {
  return new Map(chars.map((ch) => [ch, handGlyphs(ch) || []]))
}

function write(text, opts) {
  if (typeof text !== 'string' && typeof text !== 'number') fail(`write(text, options) needs a string, got ${describe(text)}`)
  text = String(text)
  opts = options(opts, 'write options')
  const size = opts.size === undefined ? 28 : num(opts.size, 'write size')
  if (size <= 0) fail('write size must be positive')
  const slant = opts.slant === undefined ? 0.12 : num(opts.slant, 'write slant')
  const lines = []
  const rows = text.split('\n')
  const glyphs = glyphsFor(rows.flatMap((row) => shapeText(row).map(([ch]) => ch)))
  const rowWidths = []
  let pen = 0
  rows.forEach((row, r) => {
    pen = 0
    const baseline = r * size * 1.75
    for (const [ch, level] of shapeText(row)) {
      const scale = level ? 0.62 : 1
      const lift = level === 1 ? -0.55 : level === -1 ? 0.3 : 0
      if (ch === ' ') {
        pen += 0.55 * size * scale
        continue
      }
      for (const glyph of glyphs.get(ch)) {
        // A little variation per letter, like a hand.
        const wob = 1 + (rng() - 0.5) * 0.06
        const dy = (rng() - 0.5) * 0.04 * size
        for (const flat of glyph.s) {
          const pts = []
          for (let k = 0; k < flat.length; k += 2) {
            const gx = flat[k] * size * scale * wob
            const gy = (flat[k + 1] + lift) * size * scale * wob
            pts.push([pen + gx - gy * slant, baseline + gy + dy])
          }
          if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5])
          lines.push(pts)
        }
        // The font's advances hold wide side bearings, so letters sit a little closer than their advances.
        pen += glyph.a * 0.92 * size * scale
      }
    }
    rowWidths.push(pen)
  })
  if (!lines.length) fail('write() has nothing to draw')
  const b = boundsOfPoints(lines.flat())
  let dx
  let dy
  if (opts.center !== undefined) {
    const [cx, cy] = pointArg(opts.center, 'write center')
    dx = cx - (b.x + b.width / 2)
    dy = cy - (b.y + b.height / 2)
  } else {
    const [ax, ay] = opts.at === undefined ? [0, 0] : pointArg(opts.at, 'write at')
    dx = ax - b.x
    dy = ay - b.y
  }
  const placed = lines.map((l) => l.map(([x, y]) => [x + dx, y + dy]))
  const { at: _a, center: _c, size: _s, slant: _sl, ...rest } = opts
  const entry = inkObject('write', placed, rest, { jitter: 0.25, width: Math.max(1.5, size / 11), speed: size * 11 })
  if (building > 0) entry.text = text
  return entry
}

/** write() with its own seeded hand: the same seed writes the same letters each time. */
export function writeInk(text: string, opts: { size?: number; slant?: number; at?: [number, number]; center?: [number, number]; color?: string; width?: number; seed?: number }) {
  rng = seeded(opts.seed ?? 7)
  const { seed: _seed, ...rest } = opts
  return write(text, rest) as { lines: [number, number][][]; color: string; width: number; speed: number; jitter: number }
}
