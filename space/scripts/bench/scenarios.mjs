/**
 * The fixed bench scenarios. Keep them the same between runs, or results
 * stop being comparable. A conversation is one app instance, one learning
 * folder, one board and one agent conversation; its scenarios run in order,
 * and a follow-up continues the conversation of the scenario before it.
 *
 * Strokes are in board coordinates (origin at the board centre, +y down),
 * [x, y, pressure] per point, as scripts/drive.mjs takes them.
 */

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

export const ALL_SCENARIOS = CONVERSATIONS.flatMap((c) => c.scenarios.map((s) => s.id))
