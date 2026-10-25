/**
 * A busy board for the perception scenarios: about an hour of earlier work
 * (agent notes, drawings, a frame, agent ink marks, and learner handwriting,
 * sketches and crossed-out lines) spread over about 3000 × 2000 board points.
 *
 * The list is fixed, so every run and every scenario gets the same board. The
 * coordinates are relative to the centre of a free hole (HOLE, ±580 × ±260)
 * where the scenario's own material and the learner's new work go. A few
 * pieces sit just outside the hole, so a crop round the new work also shows
 * neighbours.
 *
 * The agent material is written with run_scene (the one way to write since
 * stage 4, decision P13): one scene per item that shows it at once, so each
 * item keeps its own id and the bench gets its bounds back.
 */
import { loop, text, textWidth } from './handwriting.mjs'

export const HOLE = { halfWidth: 580, halfHeight: 260 }

const P = 0.55

/** A scene program that puts html material with its top-left at [x, y] at once. */
export const htmlScene = (markup, x, y) => `const m = html(${JSON.stringify(markup)}, { at: ${JSON.stringify([x, y])} })\nawait fadeIn(m, 0)`
/** A scene program that puts agent ink (strokes of [x, y] points) at once. */
export const inkScene = (strokes, color) => `const s = stroke(${JSON.stringify(strokes)}${color ? `, { color: ${JSON.stringify(color)} }` : ''})\nawait fadeIn(s, 0)`

/**
 * Run one set-up scene over `mcp` (the bench's own client: its items are
 * authored "agent") and return its first item ({id, kind, bounds}).
 */
export async function seedScene(mcp, code) {
  const result = await mcp('run_scene', { code, name: 'bench set-up', when: 'now', wait: 'end' })
  const item = Array.isArray(result?.items) ? result.items[0] : null
  if (!item) throw new Error(`run_scene made no item: ${JSON.stringify(result).slice(0, 300)}`)
  return item
}

/** Agent material: scene programs with coordinates relative to the hole centre; (dx, dy) shifts it. */
function agentItems(dx, dy) {
  const X = (x) => Math.round(x + dx)
  const Y = (y) => Math.round(y + dy)
  const at = (x, y, markup) => htmlScene(markup, X(x), Y(y))
  const note = (x, y, body, size = 28) => at(x, y, `<p style="font-size:${size}px">${body}</p>`)
  return [
    note(-1450, -950, 'Plan for today: fractions, then equations'),
    at(
      -1450,
      -560,
      '<div style="width:440px; padding:20px">' +
        '<h3 style="font-size:30px">Fractions</h3><p style="font-size:22px">A fraction is a part of a whole.</p><p style="font-size:22px">1/2 means 1 of 2 equal parts.</p><p style="font-size:22px">To add, make the denominators the same first.</p></div>'
    ),
    at(
      -1400,
      280,
      '<svg width="200" height="200" viewBox="0 0 200 200">' +
        '<circle cx="100" cy="100" r="80" fill="none" stroke="white" stroke-width="3"/>' +
        '<path d="M100,100 L100,20 A80,80 0 1,1 20,100 Z" fill="#5b8def"/>' +
        '<line x1="20" y1="100" x2="180" y2="100" stroke="white" stroke-width="2"/><line x1="100" y1="20" x2="100" y2="180" stroke="white" stroke-width="2"/></svg>'
    ),
    at(
      640,
      -130,
      '<svg width="360" height="80" viewBox="0 0 360 80">' +
        '<line x1="10" y1="40" x2="350" y2="40" stroke="white" stroke-width="3"/>' +
        [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<line x1="${20 + n * 40}" y1="30" x2="${20 + n * 40}" y2="50" stroke="white" stroke-width="2"/><text x="${14 + n * 40}" y="72" fill="white" font-size="18">${n}</text>`).join('') +
        '</svg>'
    ),
    at(
      950,
      520,
      '<svg width="260" height="180" viewBox="0 0 260 180">' +
        '<rect x="20" y="100" width="40" height="70" fill="#5b8def"/><rect x="80" y="60" width="40" height="110" fill="#5b8def"/>' +
        '<rect x="140" y="30" width="40" height="140" fill="#5b8def"/><rect x="200" y="80" width="40" height="90" fill="#5b8def"/>' +
        '<line x1="10" y1="172" x2="250" y2="172" stroke="white" stroke-width="2"/></svg>'
    ),
    note(-420, -440, 'Do the same to both sides.'),
    note(150, -770, '1/2 + 1/4 = 3/4', 32),
    note(250, 330, 'Order: × and ÷ before + and −'),
    note(1050, -900, 'Next: word problems'),
    note(-950, 700, 'Nice work on the fractions.'),
    inkScene([[[X(150), Y(-718)], [X(300), Y(-716)], [X(430), Y(-719)]]]),
    inkScene([[[X(910), Y(70)], [X(925), Y(88)], [X(955), Y(45)]]], 'good')
  ]
}

/** A straight learner line (a cross-out or a sketch edge). */
function stroke(points) {
  return points.map(([x, y]) => [x, y, P])
}

/** Learner pieces: each is the strokes of one piece of handwriting or sketch, drawn as one drive call. */
function learnerItems(dx, dy) {
  const T = (s, x, y, size = 40) => text(s, x + dx, y + dy, size)
  const crossed = (s, x, y, size = 40) => [...T(s, x, y, size), stroke([[x + dx - 8, y + dy + size * 0.55], [x + dx + textWidth(s, size) + 4, y + dy + size * 0.45]])]
  return [
    T('3 + 4 = 7', -1350, -200),
    T('12 - 5 = 7', -1350, -110),
    crossed('2 + 6 = 9', -850, 450),
    T('9 - 3 = 6', 640, 30),
    T('x + 2 = 5', -420, 320),
    T('x = 3', -420, 390),
    T('15 16 17', 1000, -560),
    T('4 x 3 = 12', 560, -470),
    [...loop(1250 + dx, 250 + dy, 70, 55), ...loop(1250 + dx, 250 + dy, 25, 20)],
    [...loop(-1000 + dx, -720 + dy, 50, 40), ...T('?', -930, -790, 40)],
    T('10 = 4 + 6', 250, 720),
    crossed('5 + 5 = 11', 100, -400),
    T('7 + 8 = 15', 900, 850),
    [stroke([[-1450 + dx, 760 + dy], [-1250 + dx, 760 + dy], [-1250 + dx, 880 + dy], [-1450 + dx, 880 + dy], [-1450 + dx, 760 + dy]]), stroke([[-1450 + dx, 760 + dy], [-1250 + dx, 880 + dy]])]
  ]
}

/**
 * Seed the busy board's agent material round a scenario whose material fits
 * in `area` ({x, y, width, height}, board points) over `mcp`. Returns the
 * learner pieces (a list of stroke lists) for the caller to draw.
 */
export async function seedBusy(area, mcp) {
  if (area.width / 2 > HOLE.halfWidth || area.height / 2 > HOLE.halfHeight) throw new Error('busy: the scenario area does not fit in the hole')
  const dx = Math.round(area.x + area.width / 2)
  const dy = Math.round(area.y + area.height / 2)
  const agent = []
  for (const code of agentItems(dx, dy)) {
    const item = await seedScene(mcp, code)
    agent.push({ kind: item.kind, id: item.id })
  }
  const learner = learnerItems(dx, dy)
  return { centre: [dx, dy], agent_items: agent.length, learner_pieces: learner.length, learner }
}
