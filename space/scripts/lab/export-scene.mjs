#!/usr/bin/env node
/**
 * Export an agent's scene for the website: run its program through the app's own scene library (src/stage/live-prelude.js),
 * as stage/worker.ts does, with the host answers stored in the scene's record (the voice lines' places), and write the
 * scene description (its objects and timeline, the voiced lines, the steps) as JSON. The program file is read as it is.
 *
 *   node scripts/lab/export-scene.mjs <record.jsonl> <scene.js> <out.json>
 *
 * record.jsonl: the board's scene record (<folder>/.learning-space/scenes/<board id>.jsonl); its first line is the scene.
 * The website plays the JSON (apps/website/components/usecases/agent-scene.ts) with the voice clip the lines name.
 */
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

// The shared modules are TypeScript with extensionless imports: Node strips the types, this hook adds the extension.
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context)
      } catch {
        // Not a TypeScript module: resolve it as it is.
      }
    }
    return next(specifier, context)
  }
})

const [recordFile, sceneFile, outFile] = process.argv.slice(2)
if (!outFile) {
  console.log('usage: node scripts/lab/export-scene.mjs <record.jsonl> <scene.js> <out.json>')
  process.exit(1)
}
const space = join(dirname(new URL(import.meta.url).pathname), '../..')
const shared = (name) => import(join(space, 'src/shared', `${name}.ts`))
const { polylineInk } = await shared('ink-points')
const { flattenPath, parsePath } = await shared('path-geometry')
const { arrowHead, arrowWings, ellipseSegments, f2, rectSegments } = await shared('pen-shapes')
const { mulberry32, SCENE_EASES, trackNumber } = await shared('live-scene')
const { programSite, siteLabel } = await shared('scene-program')
const { HAND_FONT } = await shared('hand-font')

const record = JSON.parse(readFileSync(recordFile, 'utf8').split('\n')[0])
const answers = new Map(record.source.answers ?? [])
const ctx = JSON.parse(record.source.ctx)
// As main/live-scene.ts runAgain: a scene with voice answers runs with the voice on.
if ([...answers.keys()].some((q) => q.includes('"voiceLine"'))) ctx.voice = true

let host = null
const realm = vm.createContext({})
Object.assign(realm, {
  __fontText: JSON.stringify(HAND_FONT),
  __measure: (request) => {
    const answer = answers.get(request)
    if (answer === undefined) throw new Error(`the record has no answer for ${request.slice(0, 160)}`)
    return answer
  },
  __frames: () => {},
  __framesThrough: () => {},
  __shared: Object.freeze({ parsePath, flattenPath, polylineInk, f2, ellipseSegments, rectSegments, arrowHead, arrowWings, SCENE_EASES, trackNumber, mulberry32, programSite, siteLabel }),
  __host: (fns) => {
    host = fns
  }
})
vm.runInContext(readFileSync(join(space, 'src/stage/live-prelude.js'), 'utf8'), realm, { filename: 'live-prelude.js' })
host.begin(JSON.stringify(ctx))

// The clock, as stage/worker.ts run(): every pending job runs, then the earliest action ends.
let settled = 'pending'
let reason
vm.runInContext(`(async () => {${readFileSync(sceneFile, 'utf8')}\n})()`, realm, { filename: 'scene.js' }).then(
  () => (settled = 'done'),
  (error) => {
    settled = 'failed'
    reason = error
  }
)
const tick = () => new Promise((done) => setImmediate(done))
for (;;) {
  await tick()
  if (settled === 'failed') throw reason
  const failed = host.failed()
  if (failed) throw failed.error
  if (!host.advance()) {
    await tick()
    break
  }
}
if (settled !== 'done') throw new Error('the scene still waits on something that never comes')
host.end()
host.seeds()
if (host.stepping()) throw new Error('the scene has changing objects (worlds, morphs): the website player does not play their frames')
const description = JSON.parse(host.result())
const { objects, actions, steps, duration, cues } = description
writeFileSync(outFile, JSON.stringify({ name: record.name, view: ctx.view, duration, objects, actions, steps, cues }))
console.log(`wrote ${outFile}: ${objects.length} objects, ${actions.length} actions, ${cues.length} lines, ${duration} s`)
