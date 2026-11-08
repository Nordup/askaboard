#!/usr/bin/env node
/**
 * Export an agent's scene for the website: run its program through the app's own scene library (src/stage/live-prelude.js),
 * as stage/worker.ts does, with the host answers stored in the scene's record (the voice lines' places), and write the
 * scene description (its objects and timeline, the voiced lines, the steps) as JSON, with what the app works out from it
 * after the run: the sweep's samples of each changing shape, and each ink object's strokes as live/compile.ts draws them.
 * The program file is read as it is.
 *
 *   node scripts/lab/export-scene.mjs <record.jsonl> <scene.js> <out.json> [Board.board.json]
 *
 * Board.board.json (the run's board file): its learner ink goes in as `learner`, shown from the start (--learner-board).
 * record.jsonl: the board's scene record (<folder>/.askaboard/scenes/<board id>.jsonl); its first line is the scene.
 * The website plays the JSON (apps/website/components/usecases/agent-scene.ts) with the voice clip the lines name.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inkStrokes, runScene } from './scene-host.mjs'

const [recordFile, sceneFile, outFile, boardFile] = process.argv.slice(2)
if (!outFile) {
  console.log('usage: node scripts/lab/export-scene.mjs <record.jsonl> <scene.js> <out.json> [Board.board.json]')
  process.exit(1)
}
const record = JSON.parse(readFileSync(recordFile, 'utf8').split('\n')[0])
const answers = new Map(record.source.answers ?? [])
const ctx = JSON.parse(record.source.ctx)
// As main/live-scene.ts runAgain: a scene with voice answers runs with the voice on.
if ([...answers.keys()].some((q) => q.includes('"voiceLine"'))) ctx.voice = true

const { description, host, frames } = await runScene(readFileSync(sceneFile, 'utf8'), ctx, answers)
if (host.stepping()) throw new Error('the scene has worlds that step: the website player does not play them')
// The sweep, as stage/worker.ts runs it after the description: the samples of each changing object.
let swept = null
while (!(swept = host.sample(() => true)));
const lastChange = new Map(swept.lastChange)
const { objects, actions, steps, duration, cues } = description
const r2 = (v) => Math.round(v * 100) / 100
for (const object of objects) {
  // A changing object's samples, as the player blends them (live/compile.ts prepareSample); it shows them until its last change.
  const own = frames.get(object.id)
  if (own?.length && object.kind === 'shape') {
    object.samples = own.map(({ sample }) => ({ t: sample.t, d: sample.d, ...(sample.width === undefined ? {} : { width: sample.width }) }))
    object.lastChange = Math.min(lastChange.get(object.id) ?? duration, duration)
  } else if (own?.length) throw new Error(`object ${object.id} (${object.kind}) changes over time: the website player plays only changing shapes`)
  if (object.kind !== 'ink') continue
  // The strokes as live/compile.ts makes them (scene-host.mjs inkStrokes); the player applies the object's matrix.
  const tool = object.style.tool === 'highlighter' ? 'highlighter' : 'pen'
  object.ink = {
    width: r2(Math.max(0.5, object.style.width * (tool === 'highlighter' ? 4 : 1))),
    tool,
    strokes: inkStrokes(object).map((points) => points.map(([x, y, p]) => [r2(x), r2(y), p]))
  }
  delete object.lines
}
// The learner's own ink on the board before the scene (a run with --learner-board): shown from the start, under the scene.
const learner = boardFile
  ? JSON.parse(readFileSync(boardFile, 'utf8'))
      .nodes.filter((n) => n.kind === 'ink' && n.author === 'learner')
      .map((n) => ({ color: n.color, width: n.width, tool: n.tool, points: n.points.map(([x, y, p]) => [r2(x + n.x), r2(y + n.y), p]) }))
  : []
writeFileSync(outFile, JSON.stringify({ name: record.name, view: ctx.view, camera: description.camera ?? [], duration, objects, actions, steps, cues, learner }))
console.log(`wrote ${outFile}: ${objects.length} objects, ${actions.length} actions, ${cues.length} lines, ${duration} s, ${objects.filter((o) => o.samples).length} changing`)
