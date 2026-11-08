/**
 * Glyphs of the hand font beyond the Hershey sets: Cyrillic, punctuation,
 * arrows, maths signs, special Latin letters and the combining accents that
 * write() puts on any letter (live-prelude.js composes them). Every glyph is
 * a recipe on the hand's own strokes (copy, mirror, flip, scale to x-height,
 * one more stroke) or a few strokes in the same 21-unit grid, so the pen, the
 * curves and the proportions stay the same hand.
 *
 * Grid units (as Hershey): cap height 21, x-height 14, baseline 0, descender
 * +7, maths axis -9, side bearing about 4, +y down. g() turns them into the
 * font's units (cap height 1).
 *
 * extraGlyphs(F) adds glyphs to F (char -> {a, s}, font units) and returns
 * the aliases (char -> char of the same glyph), which cost no stroke data.
 */
const r3 = (v) => Math.round(v * 1000) / 1000
const U = 21

/** A glyph from grid units. */
const g = (a, ...strokes) => ({ a: r3(a / U), s: strokes.map((s) => s.map((v) => r3(v / U))) })
/** Points on an ellipse arc in grid units, angles in degrees (0 right, 90 down). */
function arc(cx, cy, rx, ry, a0, a1, n) {
  n = n || Math.max(6, Math.round(Math.abs(a1 - a0) / 20))
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
  }
  return out
}
/** Strokes (font units) through fx, fy. */
const tf = (strokes, fx = (x) => x, fy = (y) => y) => strokes.map((s) => s.map((v, i) => r3(i % 2 ? fy(v) : fx(v))))
const shift = (strokes, dx, dy = 0) => tf(strokes, (x) => x + dx, (y) => y + dy)
const xs = (strokes) => strokes.flatMap((s) => s.filter((_, i) => i % 2 === 0))
const ys = (strokes) => strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1))
const G = (a, s) => ({ a: r3(a), s })
/** Mirror left to right inside the glyph's own ink. */
function mirror(glyph) {
  const x = xs(glyph.s)
  const lo = Math.min(...x)
  const hi = Math.max(...x)
  return G(glyph.a, tf(glyph.s, (v) => lo + hi - v))
}
/** Turn by `deg` (clockwise on the board) about (cx, cy). */
function rotate(strokes, deg, cx, cy) {
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return strokes.map((st) => {
    const out = []
    for (let i = 0; i < st.length; i += 2) {
      const dx = st[i] - cx
      const dy = st[i + 1] - cy
      out.push(r3(cx + dx * c - dy * s), r3(cy + dx * s + dy * c))
    }
    return out
  })
}
/** Move the ink so that its left edge is at x = left (the side bearing). */
function sit(strokes, left = 0.19) {
  const lo = Math.min(...xs(strokes))
  return shift(strokes, left - lo)
}

export function extraGlyphs(F) {
  const alias = {}
  const add = (ch, glyph) => {
    if (F[ch] || alias[ch]) throw new Error(`hand font: ${ch} defined twice`)
    F[ch] = glyph
  }
  const same = (pairs) => {
    for (const [ch, to] of Object.entries(pairs)) {
      if (!F[to]) throw new Error(`hand font: alias ${ch} -> ${to}: no such glyph`)
      if (F[ch]) throw new Error(`hand font: ${ch} defined twice`)
      alias[ch] = to
    }
  }

  // ---------- Parts of the hand ----------
  const bowlB = F.B.s[2] // B's lower bowl, from the stem at the middle round to the baseline
  const bowl = (dx, sx = 1) => tf([bowlB], (x) => 0.19 + dx + (x - 0.19) * sx)[0]
  /** The bowl drawn from the baseline round to the middle, so the stem and the bowl are one pen line. */
  const bowlBack = (dx, sx = 1) => {
    const b = bowl(dx, sx)
    const out = []
    for (let i = b.length - 2; i >= 0; i -= 2) out.push(b[i], b[i + 1])
    return out.slice(2)
  }

  // ---------- Latin letters that do not decompose ----------
  add('ı', G(F.i.a, [F.i.s[1]]))
  add('ȷ', G(F.j.a, [F.j.s[1]]))
  add('ß', g(20, [4, 0, 4, -15, 5, -18, 7, -20, 9, -21, 12, -21, 14, -20, 15, -18, 15, -16, 14, -14, 12, -12, 10, -12, 13, -11, 15, -10, 16, -8, 16, -4, 15, -2, 13, 0, 10, 0]))
  add('ø', G(F.o.a, [...F.o.s, [0.143, 0.048, 0.762, -0.714]]))
  add('Ø', G(F.O.a, [...F.O.s, [0.095, 0.095, 0.952, -1.095]]))
  add('ł', G(0.476, [...shift(F.l.s, 0.048), [0.048, -0.381, 0.429, -0.619]]))
  add('Ł', G(F.L.a + 0.048, [...shift(F.L.s, 0.048), [0.048, -0.381, 0.476, -0.667]]))
  add('đ', G(F.d.a + 0.048, [...F.d.s, [0.524, -0.857, 0.905, -0.857]]))
  add('Đ', G(F.D.a + 0.048, [...shift(F.D.s, 0.095), [0.048, -0.524, 0.524, -0.524]]))
  add('ħ', G(F.h.a, [...F.h.s, [0.048, -0.857, 0.476, -0.857]]))
  add('Ħ', G(F.H.a + 0.095, [...shift(F.H.s, 0.048), [0.095, -0.762, 1.048, -0.762]]))
  add('æ', G(1.381, [...F.a.s, ...shift(F.e.s, 0.524)]))
  add('œ', G(1.429, [...F.o.s, ...shift(F.e.s, 0.571)]))
  add('Æ', g(25, [1, 0, 12, -21, 23, -21], [12, -21, 12, 0, 23, 0], [12, -11, 20, -11], [5, -7, 12, -7]))
  add('Œ', g(28, [13, -21, 9, -21, 7, -20, 5, -18, 4, -16, 3, -13, 3, -8, 4, -5, 5, -3, 7, -1, 9, 0, 13, 0], [13, -21, 13, 0], [13, -21, 24, -21], [13, -11, 21, -11], [13, 0, 24, 0]))
  add('þ', G(F.p.a, [[0.19, -1, 0.19, 0.333], F.p.s[1]]))
  add('Þ', G(F.P.a, [F.P.s[0], ...shift([F.P.s[1]], 0, 0.19)]))
  add('ð', G(F['δ'].a, [...F['δ'].s, [0.286, -0.81, 0.667, -0.952]]))
  add('Ð', G(F['Đ'].a, F['Đ'].s))

  // ---------- Combining accents (live-prelude.js puts them on the base letter) ----------
  // Centred on x = 0; marks above sit on a lower-case letter (bottom at -0.81), marks below hang from the baseline.
  const dot = (cx, cy) => [cx, cy - 1, cx - 1, cy, cx, cy + 1, cx + 1, cy, cx, cy - 1]
  add('̀', g(0, [-2, -20, 1, -17]))
  add('́', g(0, [2, -20, -1, -17]))
  add('̂', g(0, [-3, -17, 0, -20, 3, -17]))
  add('̃', g(0, [-4, -17, -4, -18, -3, -19, -2, -19, 2, -18, 3, -18, 4, -19, 4, -20]))
  add('̄', g(0, [-3, -18, 3, -18]))
  add('̆', g(0, [-3, -20, -2, -18, 0, -17, 2, -18, 3, -20]))
  add('̇', g(0, dot(0, -18)))
  add('̈', g(0, dot(-3, -18), dot(3, -18)))
  add('̊', g(0, arc(0, -18.5, 1.6, 1.6, -90, 270, 10)))
  add('̋', g(0, [0, -20, -2, -17], [4, -20, 2, -17]))
  add('̌', g(0, [-3, -20, 0, -17, 3, -20]))
  add('̣', g(0, dot(0, 3)))
  add('̦', g(0, [1, 2, 0, 3, -1, 2, 0, 1, 1, 2, 1, 4, -1, 6]))
  add('̧', g(0, [0, 0, 0, 2, 2, 3, 2, 5, 0, 6, -2, 6]))
  add('̨', g(0, [0, 0, -2, 2, -2, 5, 0, 6, 2, 6]))

  // ---------- Cyrillic ----------
  same({ А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J' })
  same({ а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j' })
  add('Б', G(0.952, [[0.81, -1, 0.19, -1, 0.19, 0, ...bowlBack(0)]]))
  add('Г', g(17, [16, -21, 4, -21, 4, 0]))
  add('Ґ', g(17, [4, 0, 4, -21, 16, -21, 16, -25]))
  add('Д', g(21, [2, 3, 2, 0, 19, 0, 19, 3], [4, 0, 5, -2, 6, -5, 7, -11, 8, -21, 17, -21, 17, 0]))
  add('Ж', g(24, [2, -21, 8, -12, 12, -11, 16, -12, 22, -21], [12, -21, 12, 0], [2, 0, 8, -11, 12, -11, 16, -11, 22, 0]))
  add('З', g(20, [3, -18, 4, -20, 6, -21, 13, -21, 15, -20, 16, -19, 17, -17, 17, -15, 16, -13, 14, -11.5, 9, -11, 14, -10.5, 16, -9, 17, -7, 17, -4, 16, -2, 15, -1, 13, 0, 7, 0, 5, -1, 4, -2, 3, -4]))
  add('И', mirror(F.N))
  add('Л', g(21, [2, 0, 3, -1, 4, -3, 5, -6, 6, -11, 7, -21, 17, -21, 17, 0]))
  add('П', g(22, [4, 0, 4, -21, 18, -21, 18, 0]))
  add('У', g(19, [2, -21, 9, -7], [17, -21, 9, -7, 7, -3, 6, -1, 4, 0, 2, 0]))
  add('Ф', g(22, [11, -22, 11, 1], [11, -17, ...arc(11, -11, 8, 6, -90, 270, 18).slice(2)]))
  add('Ц', g(23, [4, -21, 4, 0, 20, 0, 20, 3], [18, -21, 18, 0]))
  add('Ч', g(21, [4, -21, 4, -15, 5, -12, 7, -11, 10, -10, 17, -10], [17, -21, 17, 0]))
  add('Ш', g(30, [4, -21, 4, 0, 26, 0, 26, -21], [15, -21, 15, 0]))
  add('Щ', g(31, [4, -21, 4, 0, 28, 0, 28, 3], [15, -21, 15, 0], [26, -21, 26, 0]))
  add('Ъ', G(1.095, [[0.048, -1, 0.333, -1, 0.333, 0, ...bowlBack(0.143)]]))
  add('Ы', G(1.238, [[0.19, -1, 0.19, 0, ...bowlBack(0, 0.9)], [1.048, -1, 1.048, 0]]))
  add('Ь', G(0.952, [[0.19, -1, 0.19, 0, ...bowlBack(0)]]))
  add('Э', G(F.C.a, [...mirror(F.C).s, [0.429, -0.524, 0.857, -0.524]]))
  add('Є', G(F.C.a, [...F.C.s, [0.19, -0.524, 0.619, -0.524]]))
  // Ю: the bar runs on into the O, which starts at its left middle.
  const oFromLeft = (() => {
    const o = tf(F.O.s, (x) => 0.381 + (x - 0.143) * 0.9)[0]
    const pts = []
    for (let i = 0; i < o.length - 2; i += 2) pts.push([o[i], o[i + 1]])
    let k = 0
    pts.forEach((p, i) => { if (p[0] < pts[k][0] || (p[0] === pts[k][0] && Math.abs(p[1] + 0.5) < Math.abs(pts[k][1] + 0.5))) k = i })
    const loop = [...pts.slice(k), ...pts.slice(0, k + 1)]
    return loop.flat()
  })()
  add('Ю', G(1.286, [[0.19, -1, 0.19, 0], [0.19, -0.524, ...oFromLeft]]))
  add('Я', mirror(F.R))

  // Print lower case: the capital at x-height, a little narrower (as n is to N).
  const small = (ch) => {
    const C = F[ch]
    const sx = 0.8
    return G((C.a - 0.38) * sx + 0.38, tf(C.s, (x) => 0.19 + (x - 0.19) * sx, (y) => (y < 0 ? y * (14 / 21) : y * 0.8)))
  }
  for (const C of 'ВГҐДЖЗИЙКЛМНПТЦЧШЩЪЫЬЭЄЮЯ') {
    if (C === 'Й') continue
    const c = C.toLowerCase()
    add(c, small(F[C] ? C : alias[C]))
  }
  add('б', G(0.952, [[0.714, -1.048, 0.619, -1, 0.429, -0.952, 0.333, -0.857, 0.238, -0.714, 0.19, -0.571, 0.143, -0.381], ...F.o.s]))
  add('ф', g(22, [11, -21, 11, 7], [11, -14, ...arc(11, -7, 7, 7, -90, 270, 18).slice(2)]))
  // The hand's own т, к, м: the small capitals above; к by K, not by the tall k.

  // ---------- Punctuation ----------
  const period = F['.'].s
  add('…', G(1.143, [...period, ...shift(period, 0.333), ...shift(period, 0.667)]))
  add('–', g(24, [3, -9, 21, -9]))
  add('—', g(36, [3, -9, 33, -9]))
  same({ '‐': '-', '‑': '-', '‒': '–', '―': '—', '‚': ',', '’': "'" })
  add('‘', G(F["'"].a, tf(F["'"].s, (x) => 0.476 - x, (y) => -1.714 - y)))
  add('“', G(0.714, [...F['‘'].s, ...shift(F['‘'].s, 0.238)]))
  add('”', G(0.714, [...F["'"].s, ...shift(F["'"].s, 0.238)]))
  add('„', G(0.714, [...F[','].s, ...shift(F[','].s, 0.238)]))
  add('«', g(18, [9, -12, 4, -7, 9, -2], [14, -12, 9, -7, 14, -2]))
  add('»', mirror(F['«']))
  add('‹', g(12, [8, -12, 3, -7, 8, -2]))
  add('›', mirror(F['‹']))
  add('•', g(12, arc(6, -9, 2.5, 2.5, -90, 270, 12), arc(6, -9, 1, 1, -90, 270, 6)))
  add('′', g(8, [6, -21, 3, -15]))
  add('″', g(12, [6, -21, 3, -15], [10, -21, 7, -15]))
  add('¡', G(F['!'].a, tf(F['!'].s, (x) => F['!'].a - x, (y) => -0.667 - y)))
  add('¿', G(F['?'].a, tf(F['?'].s, (x) => F['?'].a - x, (y) => -0.667 - y)))
  add('№', G(1.714, [...F.N.s, ...tf(F.o.s, (x) => 1.095 + (x - 0.143) * 0.6, (y) => -0.667 + y * 0.6), [1.095, -0.429, 1.476, -0.429]]))
  add('§', G(0.857, [...tf(F.S.s, (x) => 0.143 + (x - 0.143) * 0.8, (y) => -0.476 + y * 0.6), ...tf(F.S.s, (x) => 0.143 + (x - 0.143) * 0.8, (y) => y * 0.6 + 0.048)]))

  // ---------- Arrows ----------
  const arrow = F['→']
  const larrow = F['←']
  add('↔', G(arrow.a, [larrow.s[0], larrow.s[1], arrow.s[0], arrow.s[1], [0.238, -0.429, 1, -0.429]]))
  add('↦', G(arrow.a, [...arrow.s, [0.19, -0.619, 0.19, -0.238]]))
  for (const [ch, deg] of Object.entries({ '↗': -45, '↘': 45, '↙': 135, '↖': -135 })) {
    const s = rotate(arrow.s, deg, 0.619, -0.429)
    const top = Math.min(...ys(s))
    add(ch, G(0.952, sit(shift(s, 0, -0.857 - top), 0.143)))
  }
  add('⇒', g(26, [4, -12, 20, -12], [4, -6, 20, -6], [16, -16, 22, -9, 16, -2]))
  add('⇐', mirror(F['⇒']))
  add('⇔', g(30, [7, -12, 23, -12], [7, -6, 23, -6], [9, -16, 3, -9, 9, -2], [21, -16, 27, -9, 21, -2]))
  for (const [ch, deg] of Object.entries({ '⇑': -90, '⇓': 90 })) {
    const s = rotate(F['⇒'].s, deg, 0.619, -0.429)
    const top = Math.min(...ys(s))
    add(ch, G(0.952, sit(shift(s, 0, -0.952 - top), 0.143)))
  }
  add('⇌', g(26, [4, -12, 22, -12, 17, -16], [22, -6, 4, -6, 9, -2]))
  // Long arrows: the shaft longer by 10 units.
  const long = (glyph) => {
    const mid = glyph.a / 2
    return G(glyph.a + 0.476, tf(glyph.s, (x) => (x > mid ? x + 0.476 : x)))
  }
  for (const [ch, from] of Object.entries({ '⟶': '→', '⟵': '←', '⟷': '↔', '⟹': '⇒', '⟸': '⇐', '⟺': '⇔', '⟼': '↦' })) add(ch, long(F[from]))
  // ↻: a circle open at the top right, the head at the top, moving right; ↺ is its mirror.
  add('↻', g(22, arc(11, -9, 8, 8, -30, 270, 15), [7, -21, 11, -17, 7, -13]))
  add('↺', mirror(F['↻']))
  add('▶', g(20, [4, -17, 17, -9, 4, -1, 4, -17]))
  add('◀', mirror(F['▶']))
  add('▲', g(22, [3, -1, 11, -17, 19, -1, 3, -1]))
  add('▼', g(22, [3, -17, 11, -1, 19, -17, 3, -17]))
  same({ '►': '▶', '▸': '▶', '▷': '▶', '◄': '◀', '◂': '◀', '◁': '◀', '△': '▲', '▴': '▲', '▽': '▼', '▾': '▼' })

  // ---------- Shapes and marks ----------
  add('□', g(24, [4, -17, 20, -17, 20, -1, 4, -1, 4, -17]))
  add('○', g(24, arc(12, -9, 8, 8, -90, 270, 18)))
  // Filled: the circle, then a spiral in to the middle, in one line.
  const spiral = (cx, cy, r, turns) => {
    const out = []
    const n = turns * 16
    for (let i = 0; i <= n; i++) {
      const t = -Math.PI / 2 + (i / 16) * 2 * Math.PI
      const rr = r * (1 - i / n)
      out.push(cx + rr * Math.cos(t), cy + rr * Math.sin(t))
    }
    return out
  }
  add('●', g(24, [...arc(12, -9, 8, 8, -90, 270, 18), ...spiral(12, -9, 8, 4).slice(2)]))
  add('◇', g(24, [12, -18, 20, -9, 12, 0, 4, -9, 12, -18]))
  same({ '■': '□', '◻': '□', '◯': '○', '◆': '◇' })
  add('✓', g(22, [3, -10, 8, -1, 20, -21]))
  add('✗', g(22, [4, -17, 8, -12, 13, -6, 18, -1], [19, -19, 13, -12, 8, -5, 3, 1]))
  same({ '✔': '✓', '✘': '✗', '✕': '✗' })

  // ---------- Maths ----------
  add('∀', G(F.A.a, tf(F.A.s, undefined, (y) => -1 - y)))
  add('∄', G(F['∃'].a, [...F['∃'].s, [0.667, -1.095, 0.143, 0.095]]))
  add('∅', G(F['0'].a, [F['0'].s[0], [0.857, -1.095, 0.095, 0.095]]))
  add('∉', G(F['∈'].a, [...F['∈'].s, [0.762, -0.952, 0.381, 0.095]]))
  add('∋', mirror(F['∈']))
  add('⊆', G(F['⊂'].a, [...shift(F['⊂'].s, 0, -0.143), [0.19, 0.095, 0.952, 0.095]]))
  add('⊇', G(F['⊃'].a, [...shift(F['⊃'].s, 0, -0.143), [0.19, 0.095, 0.952, 0.095]]))
  add('⊄', G(F['⊂'].a, [...F['⊂'].s, [0.762, -1, 0.381, 0.143]]))
  add('∧', g(24, [4, -1, 12, -17, 20, -1]))
  add('∨', g(24, [4, -17, 12, -1, 20, -17]))
  add('¬', g(24, [4, -12, 20, -12, 20, -6]))
  add('∥', g(14, [4, -25, 4, 7], [10, -25, 10, 7]))
  same({ '⟂': '⊥', '∣': '|', '‖': '∥', '∼': '~', '∗': '*', '⋅': '·', '∙': '·', '∕': '/', '∖': '\\', '⨯': '×', '∶': ':', '⩽': '≤', '⩾': '≥', '≦': '≤', '≧': '≥', '∆': 'Δ', 'ϑ': 'θ', 'ϕ': 'φ', 'ϵ': 'ε' })
  add('⊤', G(F['⊥'].a, tf(F['⊥'].s, undefined, (y) => -1.19 - y)))
  add('∵', G(F['∴'].a, tf(F['∴'].s, undefined, (y) => -0.857 - y)))
  add('≅', G(F['~'].a, [...shift(F['~'].s, 0, -0.238), [0.19, -0.333, 1.048, -0.333], [0.19, -0.095, 1.048, -0.095]]))
  add('≃', G(F['~'].a, [...shift(F['~'].s, 0, -0.143), [0.19, -0.19, 1.048, -0.19]]))
  add('≪', g(24, [12, -15, 4, -9, 12, -3], [20, -15, 12, -9, 20, -3]))
  add('≫', mirror(F['≪']))
  add('⟨', g(14, [10, -25, 4, -9, 10, 7]))
  add('⟩', mirror(F['⟨']))
  same({ '〈': '⟨', '〉': '⟩' })
  add('⌊', g(14, [4, -25, 4, 7, 11, 7]))
  add('⌋', g(14, [3, 7, 10, 7, 10, -25]))
  add('⌈', g(14, [4, 7, 4, -25, 11, -25]))
  add('⌉', g(14, [3, -25, 10, -25, 10, 7]))
  add('∘', g(14, arc(7, -9, 3, 3, -90, 270, 10)))
  same({ '◦': '∘' })
  const ring = arc(12, -9, 8, 8, -90, 270, 18)
  add('⊕', g(24, ring, [12, -17, 12, -1], [4, -9, 20, -9]))
  add('⊖', g(24, ring, [4, -9, 20, -9]))
  add('⊗', g(24, ring, [6.3, -14.7, 17.7, -3.3], [17.7, -14.7, 6.3, -3.3]))
  add('⊙', g(24, ring, dot(12, -9)))
  const mid = F['·'].s
  add('⋯', G(1.0, [...shift(mid, 0.095), ...shift(mid, 0.381), ...shift(mid, 0.667)]))
  add('⋮', G(0.381, [...shift(mid, 0.048, -0.381), ...shift(mid, 0.048), ...shift(mid, 0.048, 0.381)]))
  add('ℏ', G(F.h.a, [...F.h.s, [0.048, -0.714, 0.429, -0.905]]))
  add('ℓ', g(13, [2, -5, 6, -10, 9, -15, 10, -18, 9, -21, 7, -21, 6, -19, 5, -15, 5, -4, 6, -1, 8, 0, 11, -1]))
  const integral = F['∫']
  add('∮', G(integral.a, [...integral.s, arc(12.5, -9, 4, 3.5, -90, 270, 12).map((v, i) => r3(v / U))]))
  add('∬', G(integral.a + 0.333, [...integral.s, ...shift(integral.s, 0.333)]))
  add('∭', G(integral.a + 0.667, [...integral.s, ...shift(integral.s, 0.333), ...shift(integral.s, 0.667)]))

  // Double-struck capitals: the letter and a second line inside its first stem (or inside the curve).
  const LETTERLIKE = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((L, i) => {
    const ch = LETTERLIKE[L] || String.fromCodePoint(0x1d538 + i)
    const base = F[L]
    const stem = base.s.find((s) => s.length === 4 && Math.hypot(s[2] - s[0], s[3] - s[1]) > 0.9)
    let extra
    if (stem && L !== 'Z') {
      const dx = Math.abs(stem[0] - stem[2]) < 1e-6 ? 0.143 : 0.143 * Math.sign(base.a / 2 - (stem[0] + stem[2]) / 2 || 1)
      extra = [r3(stem[0] + dx), stem[1], r3(stem[2] + dx), stem[3]]
    } else if (L === 'Z') {
      extra = [0.619, -1, 0.143, -0.286]
    } else {
      const lo = Math.min(...xs(base.s))
      const top = Math.min(...ys(base.s))
      const bot = Math.max(...ys(base.s))
      extra = [r3(lo + 0.143), r3(top + 0.143), r3(lo + 0.143), r3(Math.min(bot, 0) - 0.143)]
    }
    add(ch, G(base.a + 0.048, [...base.s, extra]))
  })
  return alias
}
