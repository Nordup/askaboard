/**
 * Run a scene program outside the app with the app's own scene library (src/stage/live-prelude.js), as
 * stage/worker.ts does: the shared TypeScript modules it needs, a virtual clock, and the host answers a record
 * stored (the voice lines' places, placement queries). Used by export-scene.mjs (a scene for the website) and
 * learner-board.mjs (the learner's ink before a lab run).
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

export const SPACE = join(dirname(new URL(import.meta.url).pathname), '../..')

// The shared modules are TypeScript with extensionless imports: Node strips the types, this hook adds the extension
// (and maps the renderer's '@shared/' alias to src/shared, for board/hand.ts).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@shared/')) return next(pathToFileURL(join(SPACE, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
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

const shared = (name) => import(join(SPACE, 'src/shared', `${name}.ts`))
const { polylineInk } = await shared('ink-points')
const { flattenPath, parsePath } = await shared('path-geometry')
const { arrowHead, arrowWings, ellipseSegments, f2, rectSegments } = await shared('pen-shapes')
const { mulberry32, SCENE_EASES, trackNumber } = await shared('live-scene')
const { programSite, siteLabel } = await shared('scene-program')
const { HAND_FONT } = await shared('hand-font')
const { humanize, strokeSeed } = await import(join(SPACE, 'src/renderer/src/board/hand.ts'))

/**
 * Run `code` (a scene program's body) with the context `ctx` and the host answers `answers` (a Map). Returns the
 * scene description, the host (for the sweep: host.sample) and the sweep's samples of changing objects by object id.
 */
export async function runScene(code, ctx, answers = new Map()) {
  let host = null
  const frames = new Map()
  const realm = vm.createContext({})
  Object.assign(realm, {
    __fontText: JSON.stringify(HAND_FONT),
    __measure: (request) => {
      const answer = answers.get(request)
      if (answer === undefined) throw new Error(`no host answer for ${request.slice(0, 160)}`)
      return answer
    },
    // The sweep's samples of changing objects (stage/worker.ts frameSink), by object id; seeds are left out.
    __frames: (id, kind, _math, sample, seed) => {
      if (!seed) (frames.get(id) ?? frames.set(id, []).get(id)).push({ kind, sample })
    },
    __framesThrough: () => {},
    __shared: Object.freeze({ parsePath, flattenPath, polylineInk, f2, ellipseSegments, rectSegments, arrowHead, arrowWings, SCENE_EASES, trackNumber, mulberry32, programSite, siteLabel }),
    __host: (fns) => {
      host = fns
    }
  })
  vm.runInContext(readFileSync(join(SPACE, 'src/stage/live-prelude.js'), 'utf8'), realm, { filename: 'live-prelude.js' })
  host.begin(JSON.stringify(ctx))

  // The clock, as stage/worker.ts run(): every pending job runs, then the earliest action ends.
  let settled = 'pending'
  let reason
  vm.runInContext(`(async () => {${code}\n})()`, realm, { filename: 'scene.js' }).then(
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
  return { description: JSON.parse(host.result()), host, frames }
}

/**
 * An ink object's strokes as live/compile.ts makes them: the hand's wobble and pressure (board/hand.ts humanize),
 * seeded per stroke; pressure ink keeps its own, a changing one draws even. In the object's own points, [x, y, p].
 */
export function inkStrokes(object) {
  return [...object.lines.entries()]
    .filter(([, line]) => line.length >= 2)
    .map(([lineIndex, line]) => {
      const flat = line.map(([x, y]) => [x, y])
      if (object.pressure) return line.map(([x, y, p]) => [x, y, p === undefined ? 0.5 : Math.max(0, Math.min(1, p))])
      if (object.changes) return line.map(([x, y]) => [x, y, 0.5])
      return humanize(flat, object.style.jitter ?? 0.3, mulberry32(strokeSeed(`${object.sid ?? `o${object.id}`}:${lineIndex}`, flat)))
    })
}
