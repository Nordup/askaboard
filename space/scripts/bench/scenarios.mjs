/**
 * The fixed bench scenarios. Keep them the same between runs, or results
 * stop being comparable. A conversation is one app instance, one learning
 * folder, one board and one agent conversation; its scenarios run in order,
 * and a follow-up continues the conversation of the scenario before it.
 *
 * Strokes are in board coordinates (origin at the board centre, +y down),
 * [x, y, pressure] per point, as scripts/drive.mjs takes them.
 */

import { readFileSync } from 'node:fs'
import { eraseBox, loop, text, textWidth } from './handwriting.mjs'

const P = 0.55

function circle(cx, cy, r, steps = 40) {
  const points = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    points.push([Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10, P])
  }
  return points
}

function line(x1, y1, x2, y2, steps = 12) {
  const points = []
  for (let i = 0; i <= steps; i++) points.push([x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, P])
  return points
}

/** A question mark: a hook and a dot, its top-left near (x, y). */
function questionMark(x, y) {
  const hook = []
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI + (i / 14) * Math.PI * 1.4
    hook.push([x + 14 + 14 * Math.cos(a), y + 14 + 14 * Math.sin(a), P])
  }
  hook.push([x + 14, y + 34, P], [x + 14, y + 40, P])
  return [hook, line(x + 14, y + 50, x + 14.5, y + 52, 2)]
}

/** S3: two atoms side by side, an arrow from one to the other and a question mark, up and right of the centre. */
const atomA = { x: 300, y: -200 }
const atomB = { x: 520, y: -200 }
const S3_STROKES = [
  circle(atomA.x, atomA.y, 45),
  circle(atomB.x, atomB.y, 45),
  line(360, -200, 460, -200),
  [
    [444, -212, P],
    [460, -200, P],
    [444, -188, P]
  ],
  ...questionMark(396, -290)
]

/** S4: a small circle round a spot on the left atom and a short scribble below it. */
const S4_STROKES = [
  circle(atomA.x + 18, atomA.y - 14, 13, 24),
  [
    [270, -130, P],
    [282, -142, P],
    [294, -128, P],
    [306, -142, P],
    [318, -128, P],
    [330, -140, P]
  ]
]

export const CONVERSATIONS = [
  {
    id: 'sphere',
    scenarios: [
      { id: 'S1', title: 'fresh board', prompt: 'Explain why the volume of a sphere is 4/3 π r³. Use the board.' },
      { id: 'S2', title: 'follow-up', followUp: true, prompt: "I don't get the slicing part. Show me again." }
    ]
  },
  {
    id: 'fusion',
    scenarios: [
      { id: 'S3', title: 'learner drawing', strokes: S3_STROKES, prompt: 'I drew something on the board. Is this how fusion works?' },
      { id: 'S4', title: 'learner addition', followUp: true, strokes: S4_STROKES, prompt: 'What about this part I just added?' }
    ]
  }
]

/** The S scenarios: the default selection. */
export const S_SCENARIOS = CONVERSATIONS.flatMap((c) => c.scenarios.map((s) => s.id))

/**
 * Perception scenarios: does an agent on a NEW connection notice and read
 * what the learner just did? Each runs on a fresh folder and board:
 *
 * 1. seed(mcp): the bench's own MCP client ("ls-bench") writes the agent
 *    material, so it is authored "agent"; it returns a context object.
 *    earlier(ctx): the learner's earlier strokes (drawn with drive.mjs).
 * 2. Turn 0: the agent app looks once (get_changes), not measured.
 * 3. work(ctx): the learner's new work, a list of { draw } or { erase }
 *    strokes in board coordinates (erase = an eraser pass).
 * 4. Turn 1: a new agent connection with the prompt; this turn is measured.
 *
 * checks run on the turn-1 reply; a "soft" check is recorded only.
 * area holds the scenario's own material and new work; the busy background
 * (busy.mjs) is seeded round it, the same for every scenario.
 */
const SIZE = 44
const has = (re) => (reply) => re.test(reply)
const SAYS_RIGHT = /\b(correct|right|yes|exactly|well done)\b/i

/** The first id of a write_html result and its bounds. */
function created(result) {
  const id = result.created?.[0]
  const bounds = id && result.bounds?.[id]
  if (!bounds) throw new Error(`write_html returned no bounds: ${JSON.stringify(result).slice(0, 300)}`)
  return { id, bounds }
}

const P3_LINES = { x: -160, y: [-150, -70, 10] }

export const PERCEPTION = [
  {
    id: 'P1',
    title: 'check my answer',
    prompt: 'Check this.',
    area: { x: -565, y: -60, width: 810, height: 120 },
    async seed(mcp) {
      const task = created(await mcp('write_html', { target_id: 'root', html: '<p style="left:-120px; top:-30px; font-size:40px">Try: 3 + 5 = ?</p>' }))
      return { task }
    },
    earlier: () => JSON.parse(readFileSync(new URL('../strokes/two-plus-two.json', import.meta.url), 'utf8')),
    work: ({ task }) => {
      const b = task.bounds
      return [{ draw: text('8', b.x + b.width + 24, b.y + (b.height - SIZE) / 2, SIZE) }]
    },
    checks: [
      { name: 'mentions 8', test: has(/\b8\b/) },
      { name: 'says correct', test: has(SAYS_RIGHT) }
    ]
  },
  {
    id: 'P2',
    title: "question on the agent's drawing",
    prompt: 'Why?',
    area: { x: -160, y: -230, width: 330, height: 340 },
    async seed(mcp) {
      // A right triangle (right angle bottom-left): a = left side, b = bottom, c = hypotenuse.
      const svg =
        '<svg width="300" height="240" viewBox="0 0 300 240" style="left:-150px; top:-220px">' +
        '<polygon points="50,200 260,200 50,40" fill="none" stroke="white" stroke-width="3"/>' +
        '<polyline points="50,180 70,180 70,200" fill="none" stroke="white" stroke-width="2"/>' +
        '<text x="22" y="128" fill="white" font-size="28">a</text>' +
        '<text x="148" y="232" fill="white" font-size="28">b</text>' +
        '<text x="168" y="108" fill="white" font-size="28">c</text>' +
        '</svg>'
      const triangle = created(await mcp('write_html', { target_id: 'root', html: svg }))
      const formula = created(await mcp('write_html', { target_id: 'root', html: '<p style="left:-110px; top:50px; font-size:36px">a² + b² = c²</p>' }))
      return { triangle, formula }
    },
    work: ({ triangle }) => {
      const b = triangle.bounds
      const s = b.width / 300
      // The "c" label sits at about (176, 98) in the drawing; the loop also takes in the middle of the hypotenuse.
      const cx = b.x + 170 * s
      const cy = b.y + 106 * s
      return [{ draw: loop(cx, cy, 38 * s, 30 * s) }, { draw: text('?', cx + 48 * s, cy - 62 * s, 40) }]
    },
    checks: [
      { name: 'names c or hypotenuse', test: has(/\bc\b|hypotenuse/i) },
      {
        name: 'not a/b as circled',
        soft: true,
        test: (reply) => !/\b(circled|circle|marked|pointing at|point at)\b[^.\n]{0,40}\b(side\s+)?[ab]\b(?![²^])/i.test(reply)
      }
    ]
  },
  {
    id: 'P3',
    title: 'a correction',
    prompt: 'Is it right now?',
    area: { x: -175, y: -165, width: 520, height: 235 },
    async seed() {
      return {}
    },
    earlier: () => [
      ...text('2x + 3 = 11', P3_LINES.x, P3_LINES.y[0], SIZE),
      ...text('2x = 14', P3_LINES.x, P3_LINES.y[1], SIZE),
      ...text('x = 7', P3_LINES.x, P3_LINES.y[2], SIZE)
    ],
    work: () => {
      const pad = 10
      const box = (y, str) => ({ x: P3_LINES.x - pad, y: y - pad, width: textWidth(str, SIZE) + 2 * pad, height: SIZE + 2 * pad })
      return [
        { erase: eraseBox(box(P3_LINES.y[1], '2x = 14')) },
        { erase: eraseBox(box(P3_LINES.y[2], 'x = 7')) },
        { draw: text('2x = 8', P3_LINES.x, P3_LINES.y[1], SIZE) },
        { draw: text('x = 4', P3_LINES.x, P3_LINES.y[2], SIZE) }
      ]
    },
    checks: [
      { name: 'mentions 8 or x = 4', test: has(/\b8\b|x\s*=\s*4|\b4\b/i) },
      { name: 'says right now', test: has(SAYS_RIGHT) }
    ]
  }
]

/**
 * A spectrum-like bump that peaks at fraction tp of the width (value 1 there):
 * points (0..1, 0..1) for a curve that rises fast and falls slowly.
 */
function bump(tp, steps = 32) {
  const points = []
  for (let i = 0; i <= steps; i++) {
    const t = Math.max(0.001, i / steps)
    const u = t / tp
    points.push([t, Math.pow(u, 3) * Math.exp(3 * (1 - u))])
  }
  return points
}

/** V1: the learner's sketch box (board points): a curve and an arrow above it. */
const V1_SKETCH = { width: 280, height: 210 }

/**
 * V1 is a continuation, as in the founder's first real session: turn 0 is a
 * real turn of the measured model in a thread the bench keeps (its writes are
 * the agent material); the learner then sketches beside the agent's drawing,
 * and turn 1 resumes the SAME thread with a question that does not mention
 * the board. The bench gives work() the empty spot it found beside the
 * agent's newest drawing (ctx.spot, from find_space near ctx.anchor).
 */
PERCEPTION.push({
  id: 'V1',
  title: 'drew while talking',
  lesson: { prompt: 'Explain why light from a hotter star looks bluer. Use the board.' },
  prompt: "Doesn't that mean the colour depends on where the peak is?",
  // The hole the busy board leaves free for the agent's explanation; the learner's view starts on it.
  area: { x: -560, y: -240, width: 1120, height: 480 },
  sketch: V1_SKETCH,
  async seed() {
    return {}
  },
  // A pure sketch: a curve whose peak sits left of centre, and an arrow pointing left over the peak.
  work: ({ spot }) => {
    const x0 = spot.x + 15
    const base = spot.y + spot.height - 10
    const w = 250
    const h = 150
    const curve = bump(0.28).map(([t, v]) => [Math.round((x0 + t * w) * 10) / 10, Math.round((base - v * h) * 10) / 10, P])
    const ay = base - h - 22
    const arrow = line(x0 + 0.62 * w, ay, x0 + 0.3 * w, ay)
    const head = [
      [x0 + 0.3 * w + 14, ay - 11, P],
      [x0 + 0.3 * w, ay, P],
      [x0 + 0.3 * w + 14, ay + 11, P]
    ]
    return [{ draw: [curve] }, { draw: [arrow, head] }]
  },
  checks: [
    {
      name: 'refers to the sketch',
      test: has(/your (\w+ )?(sketch|curve|drawing|arrow|graph|line)|you (drew|sketched)|you(['’]ve| have) (drawn|sketched)|the curve you|your (version|peak)/i)
    }
  ]
})

/** Turn 0: the agent app's one earlier look at the board. */
export const TURN0_PROMPT = 'Call the learning-space tool get_changes once, then reply OK.'
export const TURN0_MODEL = 'haiku'
/** Codex turn 0: the measured model at a lower reasoning effort. */
export const TURN0_CODEX_EFFORT = 'low'

export const ALL_SCENARIOS = [...S_SCENARIOS, ...PERCEPTION.map((p) => p.id)]
