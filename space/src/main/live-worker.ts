import { parentPort, workerData } from 'node:worker_threads'
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

/**
 * Runs one scene program in QuickJS (WebAssembly), in a worker thread, so a
 * program of any length never blocks the main process or the board. The
 * program sees only the scene API of live-prelude.js: no app, no files, no
 * network, no DOM. It may compute as long as it needs; STUCK_MS only frees a
 * worker that never ends (no real program comes near it). The heap has no
 * limit of its own; QuickJS's stack limit stays, so deep recursion is an error
 * and never a crash.
 */

export const STUCK_MS = 10 * 60_000
const STACK_BYTES = 1024 * 1024
const PROGRAM_FILE = 'scene.js'

interface Input {
  prelude: string
  code: string
  ctxText: string
}

export type WorkerReply = { ok: true; json: string; cueTexts: string[]; ms: number } | { ok: false; error: string; line: number | null; ms: number }

function errorText(dumped: unknown): { message: string; line: number | null } {
  if (dumped && typeof dumped === 'object') {
    const error = dumped as { name?: string; message?: string; stack?: string; lineNumber?: number; fileName?: string }
    const message = `${error.name ?? 'Error'}: ${error.message ?? String(dumped)}`
    const match = /scene\.js:(\d+)/.exec(error.stack ?? '')
    const line = match ? Number(match[1]) : error.fileName === PROGRAM_FILE && typeof error.lineNumber === 'number' ? error.lineNumber : null
    if (error.message === 'interrupted') return { message: `The program ran for ${STUCK_MS / 60_000} minutes without ending and was stopped.`, line: null }
    return { message, line }
  }
  return { message: String(dumped), line: null }
}

async function run(input: Input): Promise<WorkerReply> {
  const started = Date.now()
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMaxStackSize(STACK_BYTES)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + STUCK_MS))
  const vm = runtime.newContext()
  const fail = (dumped: unknown): WorkerReply => {
    const { message, line } = errorText(dumped)
    return { ok: false, error: /out of memory/i.test(message) ? 'The program ran out of memory.' : message, line, ms: Date.now() - started }
  }
  try {
    const ctxHandle = vm.newString(input.ctxText)
    vm.setProp(vm.global, '__ctxText', ctxHandle)
    ctxHandle.dispose()
    const prelude = vm.evalCode(input.prelude, 'live-prelude.js')
    if (prelude.error) {
      const dumped = vm.dump(prelude.error)
      prelude.error.dispose()
      return fail(dumped)
    }
    prelude.value.dispose()

    // Same line numbers as the agent's program: the wrapper adds no line before it.
    const program = vm.evalCode(`(async () => {${input.code}\n})()`, PROGRAM_FILE)
    if (program.error) {
      const dumped = vm.dump(program.error)
      program.error.dispose()
      return fail(dumped)
    }
    const promise = program.value
    try {
      // The clock: run every job, then end the earliest pending action, until nothing waits.
      for (;;) {
        const jobs = runtime.executePendingJobs()
        if (jobs.error) {
          const dumped = vm.dump(jobs.error)
          jobs.error.dispose()
          return fail(dumped)
        }
        const step = vm.evalCode('__advance()', 'live-clock.js')
        if (step.error) {
          const dumped = vm.dump(step.error)
          step.error.dispose()
          return fail(dumped)
        }
        const more = vm.dump(step.value)
        step.value.dispose()
        if (!more) break
      }
      const state = vm.getPromiseState(promise)
      if (state.type === 'rejected') {
        const dumped = vm.dump(state.error)
        state.error.dispose()
        return fail(dumped)
      }
      if (state.type === 'fulfilled' && !state.notAPromise) state.value.dispose()
      // A pending promise here waits on something that never resolves (not a scene action): the scene ends there.
    } finally {
      promise.dispose()
    }
    const result = vm.evalCode('__result()', 'live-result.js')
    if (result.error) {
      const dumped = vm.dump(result.error)
      result.error.dispose()
      return fail(dumped)
    }
    const json = vm.dump(result.value) as string
    result.value.dispose()
    const cueResult = vm.evalCode('__cueTexts()', 'live-result.js')
    let cueTexts: string[] = []
    if (cueResult.error) cueResult.error.dispose()
    else {
      cueTexts = JSON.parse(vm.dump(cueResult.value) as string) as string[]
      cueResult.value.dispose()
    }
    return { ok: true, json, cueTexts, ms: Date.now() - started }
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}

run(workerData as Input).then(
  (reply) => parentPort?.postMessage(reply),
  (error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), line: null, ms: 0 } satisfies WorkerReply)
)
