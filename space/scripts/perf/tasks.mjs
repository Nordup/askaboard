/**
 * Perf tasks: one prompt each, sent as a real session sends it. The brief
 * reaches the agent through the learning folder's AGENTS.md (brief-only), so
 * the prompt is the task text alone.
 *
 * Add a task: an id, a short title and the text. Keep tasks cheap: one small
 * drawing on an empty board. learner: (optional) strokes the bench draws
 * before the session; no task uses it yet.
 */
export const TASKS = {
  orbit: {
    title: 'Sun, Earth orbit, direction arrow',
    text: "Draw the Sun, the Earth on a circular orbit around it, and an arrow for the Earth's direction of motion."
  },
  'em-wave': {
    title: 'Electromagnetic wave in 3D (the lab council task; a large animated scene)',
    text: 'Show me how an electromagnetic wave travels in 3D.'
  }
}

export function task(id) {
  const t = TASKS[id]
  if (!t) throw new Error(`Unknown task "${id}". Known: ${Object.keys(TASKS).join(', ')}`)
  return { id, ...t }
}
