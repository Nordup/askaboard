import createWorker from './live-worker?nodeWorker'
import prelude from './live-prelude.js?raw'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription, SceneRunOptions } from '@shared/live-scene'
import type { WorkerReply } from './live-worker'
import { measureSpeech, speechOn } from './speech'

/**
 * Run a scene program (run_scene) in the sandbox: a fresh worker thread with a
 * QuickJS VM per run (see live-worker.ts). Resolves the scene description, or
 * rejects with the program's error and its line number.
 */

export class SceneProgramError extends Error {
  constructor(
    message: string,
    readonly line: number | null
  ) {
    super(line ? `Line ${line}: ${message}` : message)
  }
}

/**
 * Run a program. With speech on, a program that says something runs twice:
 * the first pass collects its lines, their real durations are measured with
 * the system voice, and the second pass (same random seed) builds the timeline
 * with them.
 */
export async function runSceneProgram(code: string, context: SceneContext): Promise<SceneDescription> {
  const seed = Math.floor(Math.random() * 2 ** 31) + 1
  const first = await runOnce(code, context, { seed, durations: {} })
  if (!speechOn() || !first.cueTexts.length) return first.desc
  const durations = await measureSpeech(first.cueTexts)
  if (!Object.keys(durations).length) return first.desc
  const second = await runOnce(code, context, { seed, durations })
  const unmeasured = second.cueTexts.filter((text) => durations[text] === undefined)
  if (unmeasured.length) {
    // Lines that differ between passes (they depend on timing): measure them and run once more.
    Object.assign(durations, await measureSpeech(unmeasured))
    return (await runOnce(code, context, { seed, durations })).desc
  }
  return second.desc
}

function runOnce(code: string, context: SceneContext, run: SceneRunOptions): Promise<{ desc: SceneDescription; cueTexts: string[] }> {
  const ctxText = JSON.stringify({ ...context, ...run, font: HAND_FONT })
  return new Promise((resolve, reject) => {
    const worker = createWorker({ workerData: { prelude, code, ctxText } })
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      action()
    }
    worker.on('message', (reply: WorkerReply) =>
      finish(() => {
        if (!reply.ok) {
          // A line after the last one is the end of the program (an unclosed bracket or string).
          const lines = code.split('\n').length
          if (reply.line !== null && reply.line > lines) reject(new SceneProgramError(`At the end of the program: ${reply.error}`, null))
          else reject(new SceneProgramError(reply.error, reply.line))
          return
        }
        try {
          resolve({ desc: JSON.parse(reply.json) as SceneDescription, cueTexts: reply.cueTexts })
        } catch (error) {
          reject(new SceneProgramError(`The scene could not be read: ${error instanceof Error ? error.message : String(error)}`, null))
        }
      })
    )
    worker.on('error', (error) => finish(() => reject(new SceneProgramError(`The sandbox failed: ${error.message}`, null))))
    worker.on('exit', (exitCode) => finish(() => reject(new SceneProgramError(`The sandbox stopped (exit code ${exitCode}).`, null))))
  })
}
