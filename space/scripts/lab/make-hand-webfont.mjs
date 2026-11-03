#!/usr/bin/env node
/**
 * Generate src/renderer/src/styles/hand.woff2: the hand of live scenes
 * (src/shared/hand-font.ts) as a real font, so that text a learner types looks
 * like what an agent writes. Run it from space/ after hand-font.ts changes:
 *
 *   node scripts/lab/make-hand-webfont.mjs
 *
 * Each stroke gets the look of humanize() (renderer/src/agent/ink.ts): a small
 * sideways wobble and a taper at both ends. A stroke becomes one solid outline:
 * discs and quads along the line, joined by a polygon union, so joins are round
 * and an overlap leaves no hole. Each character has three variants with their
 * own wobble, size and baseline; the font's `calt` feature cycles them, so
 * repeated letters differ. Everything is seeded: the same input gives the same file.
 *
 * Tools (dev only, nothing here loads at run time): opentype.js (MIT), wawoff2
 * (MIT), clipper-lib (Boost).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ClipperLib from 'clipper-lib'
import opentype from 'opentype.js'
import wawoff2 from 'wawoff2'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '../../src/shared/hand-font.ts')
const TARGET = join(here, '../../src/renderer/src/styles/hand.woff2')

const FAMILY = 'Learning Hand'
const EM = 1000
const ASCENT = 900
const DESCENT = -300
/** The hand's units are cap heights. */
const CAP = 0.78 * EM
const SLANT = 0.12
const ADVANCE = 0.92
const SPACE = 0.42 * EM
const VARIANTS = 3
/** Sample step along a stroke, in em units. */
const STEP = 0.016 * EM
const WOBBLE = 0.016 * EM
const WOBBLE_SLOW = 0.6 * EM
const WOBBLE_FAST = 0.2 * EM
const PRESSURE_SLOW = 0.78 * EM
const TAPER = 0.5 * EM
const TAPER_SHARE = 0.18
const LINE = 0.07 * EM
const DISC_SIDES = 16
/** An outline point may leave the true shape by this much (em units). */
const TOLERANCE = 0.9
/** A pinhole where lines meet closes: no hole below this area (square em units). */
const MIN_HOLE = 160
/** Clipper works in integers: this many per em unit. */
const GRID = 100
/** Ink keeps this far inside its glyph box on each side (em units): a glyph's ink never crosses into the next one's. */
const BEARING = 0.02 * EM
/** The line's ascent and descent cover the ink with this much to spare (em units). */
const INK_MARGIN = 0.01 * EM
/** The board's line height for text (line-height in src/renderer/src/board/content.css): the line box the ink must stay in. */
const LINE_HEIGHT = 1.4

// ---------- The hand ----------

const source = readFileSync(SOURCE, 'utf8')
const HAND = JSON.parse(source.slice(source.indexOf('{', source.indexOf('HAND_FONT')), source.lastIndexOf('}') + 1))

function fontGlyph(ch) {
  let g = HAND[ch]
  while (typeof g === 'string') g = HAND[g]
  return g || null
}

// Accents: the rule of compose() in src/stage/live-prelude.js, so that typed and written letters agree.
const MARK = /\p{M}/u
const BELOW = new Set(['̣', '̦', '̧', '̨'])
const DOTLESS = { i: 'ı', j: 'ȷ', і: 'ı', ј: 'ȷ' }
const CARON_AS_APOSTROPHE = new Set(['d', 't', 'l', 'L'])
const XHEIGHT = 0.667
const moved = (strokes, dx, dy) => strokes.map((s) => s.map((v, k) => (k % 2 ? v + dy : v + dx)))
function inkBox(strokes) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const s of strokes)
    for (let k = 0; k < s.length; k += 2) {
      x0 = Math.min(x0, s[k]); x1 = Math.max(x1, s[k])
      y0 = Math.min(y0, s[k + 1]); y1 = Math.max(y1, s[k + 1])
    }
  return { x0, x1, y0, y1 }
}
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
    if (m === '̌' && CARON_AS_APOSTROPHE.has(base)) {
      strokes.push(...moved(fontGlyph("'").s, box.x1 - 0.1, box.y0 + 1))
      a += 0.14
      continue
    }
    const mark = fontGlyph(m).s
    if (BELOW.has(m)) {
      strokes.push(...moved(mark, m === '̨' ? box.x1 - 0.1 : (box.x0 + box.x1) / 2, Math.max(0, box.y1)))
      continue
    }
    const placed = moved(mark, (box.x0 + box.x1) / 2, top + XHEIGHT + (top < -0.75 ? 0.05 : 0))
    strokes.push(...placed)
    top = inkBox(placed).y0 - 0.1
  }
  return { a, s: strokes }
}

// ---------- Stroke to outline ----------

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function densify(points) {
  const out = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP))
    for (let k = 1; k <= steps; k++) out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps])
  }
  return out
}

/** The idea of humanize(): points with a sideways wobble, and a radius from a pressure with tapered ends. */
function humanize(line, random) {
  const dense = densify(line)
  const lengths = [0]
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]))
  const total = lengths[lengths.length - 1]
  const taper = Math.max(1, Math.min(TAPER, total * TAPER_SHARE))
  const phase = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2]
  const base = 0.5 + random() * 0.1
  return dense.map((point, i) => {
    const s = lengths[i]
    const a = dense[Math.max(0, i - 1)]
    const b = dense[Math.min(dense.length - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const wobble = WOBBLE * (0.7 * Math.sin(s / WOBBLE_SLOW + phase[0]) + 0.3 * Math.sin(s / WOBBLE_FAST + phase[1]))
    const ends = 0.25 + 0.75 * Math.min(1, s / taper, (total - s) / (taper * 1.4))
    const pressure = Math.max(0.08, Math.min(1, base * ends + 0.05 * Math.sin(s / PRESSURE_SLOW + phase[2])))
    return { x: point[0] - ((b[1] - a[1]) / len) * wobble, y: point[1] + ((b[0] - a[0]) / len) * wobble, r: (LINE * (0.35 + 1.3 * pressure)) / 2 }
  })
}

const toPath = (points) => points.map(([x, y]) => ({ X: Math.round(x * GRID), Y: Math.round(y * GRID) }))

function positive(path) {
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
  return path
}

function disc({ x, y, r }) {
  const points = []
  for (let i = 0; i < DISC_SIDES; i++) points.push([x + r * Math.cos((i * 2 * Math.PI) / DISC_SIDES), y + r * Math.sin((i * 2 * Math.PI) / DISC_SIDES)])
  return positive(toPath(points))
}

function quad(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (!len) return null
  const nx = -(b.y - a.y) / len
  const ny = (b.x - a.x) / len
  return positive(toPath([[a.x + nx * a.r, a.y + ny * a.r], [b.x + nx * b.r, b.y + ny * b.r], [b.x - nx * b.r, b.y - ny * b.r], [a.x - nx * a.r, a.y - ny * a.r]]))
}

/** Douglas-Peucker on an open run of points. */
function thin(points, tolerance) {
  const keep = new Array(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [from, to] = stack.pop()
    const a = points[from]
    const b = points[to]
    const len = Math.hypot(b.X - a.X, b.Y - a.Y)
    let worst = -1
    let at = -1
    for (let i = from + 1; i < to; i++) {
      const p = points[i]
      const d = len ? Math.abs((b.X - a.X) * (a.Y - p.Y) - (a.X - p.X) * (b.Y - a.Y)) / len : Math.hypot(p.X - a.X, p.Y - a.Y)
      if (d > worst) { worst = d; at = i }
    }
    if (worst > tolerance) {
      keep[at] = true
      stack.push([from, at], [at, to])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** A closed contour, thinned from its two farthest points so that no corner depends on where it starts. */
function thinClosed(contour, tolerance) {
  let far = 0
  let best = -1
  for (let i = 0; i < contour.length; i++) {
    const d = Math.hypot(contour[i].X - contour[0].X, contour[i].Y - contour[0].Y)
    if (d > best) { best = d; far = i }
  }
  const one = thin(contour.slice(0, far + 1), tolerance)
  const two = thin([...contour.slice(far), contour[0]], tolerance)
  return [...one.slice(0, -1), ...two.slice(0, -1)]
}

function outline(strokes, random) {
  const scale = CAP * (1 + (random() - 0.5) * 0.06)
  const dy = (random() - 0.5) * 0.04 * CAP
  const shapes = []
  for (const flat of strokes) {
    const line = []
    for (let k = 0; k < flat.length; k += 2) {
      const gy = flat[k + 1] * scale
      line.push([flat[k] * scale - gy * SLANT, gy + dy])
    }
    if (line.length === 1) line.push([line[0][0] + 0.5, line[0][1] + 0.5])
    const points = humanize(line, random)
    for (let i = 0; i < points.length; i++) {
      shapes.push(disc(points[i]))
      const q = i ? quad(points[i - 1], points[i]) : null
      if (q) shapes.push(q)
    }
  }
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(shapes, ClipperLib.PolyType.ptSubject, true)
  const solution = []
  clipper.Execute(ClipperLib.ClipType.ctUnion, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  const path = new opentype.Path()
  let points = 0
  for (const contour of solution) {
    const hole = !ClipperLib.Clipper.Orientation(contour)
    if (hole && Math.abs(ClipperLib.Clipper.Area(contour)) < MIN_HOLE * GRID * GRID) continue
    const thinned = thinClosed(contour, TOLERANCE * GRID)
    if (thinned.length < 3) continue
    points += thinned.length
    thinned.forEach((p, i) => {
      const x = Math.round(p.X / GRID)
      const y = Math.round(-p.Y / GRID)
      if (i) path.lineTo(x, y)
      else path.moveTo(x, y)
    })
    path.close()
  }
  return { path, points }
}

// ---------- The font ----------

/** Characters: the hand's own, with aliases sharing a glyph; the accented letters it can compose. */
const groups = new Map()
const addTo = (id, glyph, code) => {
  if (!groups.has(id)) groups.set(id, { id, glyph, codes: [] })
  groups.get(id).codes.push(code)
}
for (const [ch, value] of Object.entries(HAND)) {
  let target = ch
  let g = value
  while (typeof g === 'string') { target = g; g = HAND[g] }
  if (!g) throw new Error(`alias without a glyph: ${ch}`)
  addTo(target, g, ch.codePointAt(0))
}
const COMPOSED = [[0xc0, 0x24f], [0x386, 0x3ce], [0x400, 0x4ff], [0x1e00, 0x1eff]]
for (const [from, to] of COMPOSED)
  for (let code = from; code <= to; code++) {
    const ch = String.fromCodePoint(code)
    if (HAND[ch] || ch.normalize('NFD') === ch) continue
    const g = compose(ch)
    if (g) addTo(ch, g, code)
  }

const SPACE_ID = ' '
const groupList = [...groups.values()]
groupList.unshift({ id: SPACE_ID, glyph: null, codes: [0x20, 0xa0] })

const seedOf = (text) => {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619)
  return h >>> 0
}

/** A path moved right by dx (em units). */
function shifted(path, dx) {
  if (!dx) return path
  const out = new opentype.Path()
  out.commands = path.commands.map((c) => (c.type === 'Z' ? c : { ...c, x: c.x + dx }))
  return out
}

/**
 * Each character's variants, with one glyph box for all of them: the ink starts BEARING right of 0 (a
 * glyph whose slant or wobble reaches left moves right) and the advance is at least the ink's right edge
 * plus BEARING. So text measured by its advances holds its ink, as the board lays text out by advances.
 */
const glyphs = [new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: new opentype.Path() })]
let outlinePoints = 0
let inkTop = 0
let inkBottom = 0
/**
 * A letter whose marks stack (two or more marks, or a mark below a letter that descends) is taller than
 * any line of the board's line height can hold together with the rest: its ink does not set the line's
 * metrics, and the log names how many there are. Every other glyph's ink stays inside the line box.
 */
function stacked(group) {
  const [base, ...marks] = Array.from(group.id.normalize('NFD'))
  if (!marks.length || !marks.every((m) => MARK.test(m))) return false
  if (marks.length >= 2) return true
  const glyph = fontGlyph(base)
  return BELOW.has(marks[0]) && !!glyph && inkBox(glyph.s).y1 > 0.05
}
const tall = []
const outlines = groupList.map((group) => {
  if (!group.glyph) return null
  const variants = []
  for (let variant = 0; variant < VARIANTS; variant++) {
    const random = mulberry32(seedOf(group.id) + variant * 7919)
    const { path, points } = outline(group.glyph.s, random)
    outlinePoints += points
    variants.push(path)
  }
  const boxes = variants.map((path) => path.getBoundingBox()).filter((box) => Number.isFinite(box.x1) && box.x2 > box.x1)
  const x0 = boxes.length ? Math.min(...boxes.map((box) => box.x1)) : 0
  const x1 = boxes.length ? Math.max(...boxes.map((box) => box.x2)) : 0
  if (stacked(group)) tall.push(group.id)
  else
    for (const box of boxes) {
      inkTop = Math.max(inkTop, box.y2)
      inkBottom = Math.min(inkBottom, box.y1)
    }
  const dx = boxes.length && x0 < BEARING ? Math.ceil(BEARING - x0) : 0
  const advance = Math.max(Math.round(group.glyph.a * ADVANCE * CAP), boxes.length ? Math.ceil(x1 + dx + BEARING) : 0)
  return { paths: variants.map((path) => shifted(path, dx)), advance }
})
for (let variant = 0; variant < VARIANTS; variant++) {
  groupList.forEach((group, index) => {
    const name = `g${index}${variant ? `.${variant}` : ''}`
    const unicodes = variant ? [] : group.codes
    const made = outlines[index]
    if (!made) {
      glyphs.push(new opentype.Glyph({ name, unicodes, advanceWidth: Math.round(SPACE), path: new opentype.Path() }))
      return
    }
    glyphs.push(new opentype.Glyph({ name, unicodes, advanceWidth: made.advance, path: made.paths[variant] }))
  })
}
// The line holds the ink: ascent and descent (hhea from the font's ascender and descender, OS/2 typo and win) at least the ink's extent.
const ascent = Math.max(ASCENT, Math.ceil(inkTop + INK_MARGIN))
const descent = Math.min(DESCENT, Math.floor(inkBottom - INK_MARGIN))
if (ascent - descent > LINE_HEIGHT * EM) throw new Error(`the ink (ascent ${ascent}, descent ${descent}) is taller than a line of ${LINE_HEIGHT} em`)

const font = new opentype.Font({ familyName: FAMILY, styleName: 'Regular', unitsPerEm: EM, ascender: ascent, descender: descent, weightClass: 400, glyphs })
font.tables.os2 = { ...font.tables.os2, sCapHeight: Math.round(CAP), sTypoAscender: ascent, sTypoDescender: descent, sTypoLineGap: 0, usWinAscent: ascent, usWinDescent: -descent }

// calt: the glyphs of a variant sit in one run, so a set is a range and one substitution is one delta.
const count = groupList.length
const set = (variant) => ({ format: 2, ranges: [{ start: 1 + variant * count, end: variant * count + count, index: 0 }] })
const swap = (variant) => ({ lookupType: 1, lookupFlag: 0, subtables: [{ substFormat: 1, coverage: set(0), deltaGlyphId: variant * count }] })
const after = (variant, lookupListIndex) => ({
  substFormat: 3,
  backtrackCoverage: [set(variant)],
  inputCoverage: [set(0)],
  lookaheadCoverage: [],
  lookupRecords: [{ sequenceIndex: 0, lookupListIndex }]
})
font.tables.gsub = {
  version: 1,
  scripts: [{ tag: 'DFLT', script: { defaultLangSys: { reserveRequired: 0, reqFeatureIndex: 0xffff, featureIndexes: [0] }, langSysRecords: [] } }],
  features: [{ tag: 'calt', feature: { featureParams: 0, lookupListIndexes: [0] } }],
  lookups: [{ lookupType: 6, lookupFlag: 0, subtables: [after(0, 1), after(1, 2)] }, swap(1), swap(2)]
}

await wawoff2.compress(new Uint8Array(font.toArrayBuffer())).then((data) => writeFileSync(TARGET, data) ?? console.log(`${TARGET}: ${(data.length / 1024).toFixed(0)} KB, ${count} characters × ${VARIANTS}, ${outlinePoints} outline points, ascent ${ascent}, descent ${descent} (${tall.length} letters with stacked marks reach past them)`))
