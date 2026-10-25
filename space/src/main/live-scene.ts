import createWorker from './live-worker?nodeWorker'
import prelude from './live-prelude.js?raw'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription } from '@shared/live-scene'
import type { WorkerReply } from './live-worker'

/**
 * Run a scene program (run_scene) in the sandbox: a fresh worker thread with a
 * QuickJS VM per run (see live-worker.ts). Resolves the scene description, or
 * rejects with the program's error and its line number.
 */

/** The worker stops a stuck program itself; this frees a worker that does not even answer then. */
const HARD_STOP_MS = 11 * 60_000

export class SceneProgramError extends Error {
  constructor(
    message: string,
    readonly line: number | null
  ) {
    super(line ? `Line ${line}: ${message}` : message)
  }
}

export function runSceneProgram(code: string, context: SceneContext): Promise<SceneDescription> {
  const ctxText = JSON.stringify({ ...context, font: HAND_FONT })
  return new Promise((resolve, reject) => {
    const worker = createWorker({ workerData: { prelude, code, ctxText } })
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      action()
    }
    const timer = setTimeout(() => finish(() => reject(new SceneProgramError('The program ran for 11 minutes without ending and was stopped.', null))), HARD_STOP_MS)
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
          resolve(JSON.parse(reply.json) as SceneDescription)
        } catch (error) {
          reject(new SceneProgramError(`The scene could not be read: ${error instanceof Error ? error.message : String(error)}`, null))
        }
      })
    )
    worker.on('error', (error) => finish(() => reject(new SceneProgramError(`The sandbox failed: ${error.message}`, null))))
    worker.on('exit', (exitCode) => finish(() => reject(new SceneProgramError(`The sandbox stopped (exit code ${exitCode}).`, null))))
  })
}
