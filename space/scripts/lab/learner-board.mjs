/**
 * The learner's own work on the board before a lab run (council.mjs --learner-board), in the board's own ink.
 *
 * The work is written as a scene program (write(), stroke(); council/learners/*.js), so the app's scene library
 * lays out the handwriting (src/stage/live-prelude.js, run by scene-host.mjs) and the app's hand turns each line
 * into pen ink with its wobble and pressure (board/hand.ts humanize, as live/compile.ts does for a scene's ink).
 * The strokes then become the learner's ink nodes (author "learner") in a board file that the app opens.
 *
 *   node scripts/lab/learner-board.mjs <program.js> <out Board.board.json>   (a check of one program)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inkStrokes, runScene } from './scene-host.mjs'

// The view and window of a lab app (the context a scene gets there).
const CTX = {
  nodes: {},
  names: {},
  view: { x: -607.1, y: -427.1, width: 1214.1, height: 854.1 },
  covered: [],
  viewport: [1032, 726],
  revision: 1,
  board: 'boards/Board.board.json',
  stage: { epoch: 'st1', items: {}, first: 0 },
  seed: 1,
  cutAt: null
}

/** The board file (JSON text) with the program's ink as the learner's. */
export async function learnerBoard(programFile) {
  const { description } = await runScene(readFileSync(programFile, 'utf8'), CTX)
  const nodes = []
  for (const object of description.objects) {
    if (object.kind !== 'ink' || object.removed) continue
    if (!/^#|^rgb/.test(object.style.color)) throw new Error(`${object.api}: give the ink a CSS colour (the pen's), not "${object.style.color}"`)
    // Each line of the object is one stroke, as live/compile.ts makes it (scene-host.mjs inkStrokes).
    for (const points of inkStrokes(object)) {
      const seq = nodes.length + 1
      nodes.push({ id: `s_l${seq}`, kind: 'ink', x: 0, y: 0, z: seq, author: 'learner', seq, tool: 'pen', color: object.style.color, width: Math.round(Math.max(0.5, object.style.width) * 100) / 100, points })
    }
  }
  return `${JSON.stringify({ format: 'askaboard.board', version: 2, nextSeq: nodes.length + 1, nodes })}\n`
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [program, out] = process.argv.slice(2)
  if (!out) {
    console.log('usage: node scripts/lab/learner-board.mjs <program.js> <out Board.board.json>')
    process.exit(1)
  }
  writeFileSync(out, await learnerBoard(program))
  console.log(`wrote ${out}`)
}
