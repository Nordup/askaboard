/**
 * Simple handwriting for the bench: turn a string into pen strokes at a board
 * position. The glyphs are plain polylines in a box 1 unit high (y down), so
 * the result reads as handwriting in a screenshot, not as a font.
 *
 *   text('2x = 8', x, y, size) → [[[x, y, pressure], ...], ...]
 *
 * (x, y) is the top-left of the first glyph; size is the glyph height in
 * board points. Characters: 0-9, x, +, -, =, ?, and space.
 */

const P = 0.55

/** Points on an elliptical arc, angles in degrees (0 = right, 90 = down). */
function arc(cx, cy, rx, ry, from, to, steps = 14) {
  const points = []
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return points
}

/** Each glyph: { w: advance width in units, strokes: polylines in units }. */
const GLYPHS = {
  0: { w: 0.55, strokes: [arc(0.275, 0.5, 0.26, 0.5, -90, 270, 28)] },
  1: { w: 0.4, strokes: [[[0.08, 0.2], [0.3, 0], [0.3, 1]]] },
  2: { w: 0.55, strokes: [[...arc(0.27, 0.27, 0.25, 0.25, 200, 380), [0.05, 1], [0.58, 1]]] },
  3: { w: 0.55, strokes: [[...arc(0.27, 0.25, 0.24, 0.24, 210, 450), ...arc(0.27, 0.73, 0.27, 0.27, 270, 510)]] },
  4: { w: 0.6, strokes: [[[0.45, 1], [0.45, 0], [0, 0.68], [0.62, 0.68]]] },
  5: { w: 0.55, strokes: [[[0.55, 0], [0.1, 0], [0.06, 0.45], ...arc(0.28, 0.7, 0.27, 0.3, 240, 500)]] },
  6: { w: 0.55, strokes: [[[0.46, 0], [0.26, 0.14], [0.1, 0.36], [0.04, 0.62], ...arc(0.28, 0.72, 0.24, 0.27, 180, 540, 20)]] },
  7: { w: 0.55, strokes: [[[0, 0], [0.58, 0], [0.18, 1]]] },
  8: { w: 0.55, strokes: [arc(0.275, 0.24, 0.21, 0.24, 90, 450, 24), arc(0.275, 0.74, 0.27, 0.26, -90, 270, 24)] },
  9: { w: 0.55, strokes: [[...arc(0.27, 0.28, 0.25, 0.28, 0, 360, 24), [0.52, 1]]] },
  x: {
    w: 0.5,
    strokes: [
      [[0.02, 0.45], [0.48, 1]],
      [[0.48, 0.45], [0.02, 1]]
    ]
  },
  '+': {
    w: 0.55,
    strokes: [
      [[0.04, 0.6], [0.52, 0.6]],
      [[0.28, 0.35], [0.28, 0.85]]
    ]
  },
  '-': { w: 0.5, strokes: [[[0.04, 0.6], [0.46, 0.6]]] },
  '=': {
    w: 0.55,
    strokes: [
      [[0.04, 0.48], [0.52, 0.48]],
      [[0.04, 0.72], [0.52, 0.72]]
    ]
  },
  '?': {
    w: 0.5,
    strokes: [
      [...arc(0.25, 0.22, 0.22, 0.22, 190, 420), [0.25, 0.68]],
      [[0.25, 0.92], [0.26, 0.97]]
    ]
  },
  ' ': { w: 0.35, strokes: [] }
}

/** Add points so no segment is longer than `step` board points (smooth pen input). */
function densify(points, step = 3) {
  const out = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]
    const [x2, y2] = points[i]
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step))
    for (let k = 1; k <= n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n])
  }
  return out
}

const round = (v) => Math.round(v * 10) / 10

export function text(string, x, y, size) {
  const strokes = []
  let cursor = x
  for (const char of string) {
    const glyph = GLYPHS[char]
    if (!glyph) throw new Error(`handwriting: no glyph for "${char}"`)
    for (const stroke of glyph.strokes) {
      const points = densify(stroke.map(([u, v]) => [cursor + u * size, y + v * size]))
      strokes.push(points.map(([px, py]) => [round(px), round(py), P]))
    }
    cursor += (glyph.w + (char === ' ' ? 0 : 0.22)) * size
  }
  return strokes
}

/** The width of the string in board points. */
export function textWidth(string, size) {
  let width = 0
  for (const char of string) width += ((GLYPHS[char]?.w ?? 0.5) + (char === ' ' ? 0 : 0.22)) * size
  return width
}

/** A hand-drawn loop round a centre, slightly open and overlapping like a real circle. */
export function loop(cx, cy, rx, ry) {
  const points = arc(cx, cy, rx, ry, -100, 280, 48).map(([px, py], i) => [px + Math.sin(i / 5) * 2, py + Math.cos(i / 7) * 2])
  return [densify(points).map(([px, py]) => [round(px), round(py), P])]
}

/**
 * An eraser pass over a box: a dense zigzag, so the eraser (radius 10 screen
 * px) touches every stroke inside the box and nothing far outside it.
 */
export function eraseBox(box, pitch = 8) {
  const points = []
  let down = true
  for (let px = box.x; px <= box.x + box.width; px += pitch) {
    points.push([px, down ? box.y : box.y + box.height], [px, down ? box.y + box.height : box.y])
    down = !down
  }
  return [densify(points, 2).map(([px, py]) => [round(px), round(py), P])]
}
