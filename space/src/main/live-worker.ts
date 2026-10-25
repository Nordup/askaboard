import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads'
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten'

/**
 * The stage's sandbox: one QuickJS (WebAssembly) context in a worker thread,
 * kept alive across run_scene calls (main/stage.ts), so objects, values and
 * `stage` from one program are there for the next. A program sees only the
 * scene API of live-prelude.js: no app, no files, no network, no DOM. It may
 * compute as long as it needs: there is no time limit (founder's rule: no
 * caps). The heap has no limit of its own; QuickJS's stack limit stays, so
 * deep recursion is an error and never a crash.
 *
 * tex() and text() measure their size as the board lays them out while the
 * program runs: the worker asks the main process over `port` and waits on
 * `flag` (Atomics), so a program runs once, with exact text sizes.
 */

const STACK_BYTES = 1024 * 1024
const PROGRAM_FILE = 'scene.js'

interface Init {
  prelude: string
  fontText: string
  port: MessagePort
  flag: SharedArrayBuffer
}

/** One program. mode "scene": run, return the description, bake. "preview": run and return (the stage is rebuilt after). "replay": run and bake only (rebuilding the stage). */
export interface WorkerRun {
  type: 'run'
  id: number
  code: string
  ctxText: string
  mode: 'scene' | 'preview' | 'replay'
}

export interface WorkerReset {
  type: 'reset'
  id: number
}

export type WorkerReply = { id: number; ok: true; json: string | null; ms: number } | { id: number; ok: false; error: string; line: number | null; ms: number }

const init = workerData as Init
const flag = new Int32Array(init.flag)

/** Ask the main process to measure text; blocks this thread until it answers. */
function measureSync(request: string): string {
  // Drop an answer that came too late for an earlier request.
  while (receiveMessageOnPort(init.port)) {
    /* discard */
  }
  Atomics.store(flag, 0, 0)
  init.port.postMessage(request)
  for (;;) {
    Atomics.wait(flag, 0, 0, 200)
    const message = receiveMessageOnPort(init.port)
    if (message) return String(message.message)
  }
}

function errorText(dumped: unknown): { message: string; line: number | null } {
  if (dumped && typeof dumped === 'object') {
    const error = dumped as { name?: string; message?: string; stack?: string; lineNumber?: number; fileName?: string }
    const message = `${error.name ?? 'Error'}: ${error.message ?? String(dumped)}`
    const match = /scene\.js:(\d+)/.exec(error.stack ?? '')
    const line = match ? Number(match[1]) : error.fileName === PROGRAM_FILE && typeof error.lineNumber === 'number' ? error.lineNumber : null
    return { message, line }
  }
  return { message: String(dumped), line: null }
}

let runtime: QuickJSRuntime | null = null
let vm: QuickJSContext | null = null

async function newContext(): Promise<string | null> {
  const QuickJS = await getQuickJS()
  vm?.dispose()
  runtime?.dispose()
  runtime = QuickJS.newRuntime()
  runtime.setMaxStackSize(STACK_BYTES)
  vm = runtime.newContext()
  const ctx = vm
  const font = ctx.newString(init.fontText)
  ctx.setProp(ctx.global, '__fontText', font)
  font.dispose()
  const measure = ctx.newFunction('__measure', (arg) => ctx.newString(measureSync(ctx.getString(arg))))
  ctx.setProp(ctx.global, '__measure', measure)
  measure.dispose()
  const prelude = ctx.evalCode(init.prelude, 'live-prelude.js')
  if (prelude.error) {
    const dumped = ctx.dump(prelude.error)
    prelude.error.dispose()
    return errorText(dumped).message
  }
  prelude.value.dispose()
  return null
}

function evalHost(code: string, file: string): { ok: true; value: unknown } | { ok: false; dumped: unknown } {
  const ctx = vm as QuickJSContext
  const result = ctx.evalCode(code, file)
  if (result.error) {
    const dumped = ctx.dump(result.error)
    result.error.dispose()
    return { ok: false, dumped }
  }
  const value = ctx.dump(result.value)
  result.value.dispose()
  return { ok: true, value }
}

function runProgram(input: WorkerRun): WorkerReply {
  const started = Date.now()
  const ctx = vm as QuickJSContext
  const rt = runtime as QuickJSRuntime
  const fail = (dumped: unknown): WorkerReply => {
    const { message, line } = errorText(dumped)
    return { id: input.id, ok: false, error: /out of memory/i.test(message) ? 'The program ran out of memory.' : message, line, ms: Date.now() - started }
  }
  const ctxHandle = ctx.newString(input.ctxText)
  ctx.setProp(ctx.global, '__ctxText', ctxHandle)
  ctxHandle.dispose()
  const begin = evalHost('__begin()', 'live-host.js')
  if (!begin.ok) return fail(begin.dumped)

  // Same line numbers as the agent's program: the wrapper adds no line before it.
  const program = ctx.evalCode(`(async () => {${input.code}\n})()`, PROGRAM_FILE)
  if (program.error) {
    const dumped = ctx.dump(program.error)
    program.error.dispose()
    return fail(dumped)
  }
  const promise = program.value
  try {
    // The clock: run every job, then end the earliest pending action, until nothing waits.
    for (;;) {
      const jobs = rt.executePendingJobs()
      if (jobs.error) {
        const dumped = ctx.dump(jobs.error)
        jobs.error.dispose()
        return fail(dumped)
      }
      const step = evalHost('__advance()', 'live-clock.js')
      if (!step.ok) return fail(step.dumped)
      if (!step.value) break
    }
    const state = ctx.getPromiseState(promise)
    if (state.type === 'rejected') {
      const dumped = ctx.dump(state.error)
      state.error.dispose()
      return fail(dumped)
    }
    if (state.type === 'fulfilled' && !state.notAPromise) state.value.dispose()
    // A pending promise here waits on something that never resolves (not a scene action): the scene ends there.
  } finally {
    promise.dispose()
  }
  let json: string | null = null
  if (input.mode !== 'replay') {
    const result = evalHost('__result()', 'live-result.js')
    if (!result.ok) return fail(result.dumped)
    json = result.value as string
  }
  if (input.mode !== 'preview') {
    const bake = evalHost('__bake()', 'live-result.js')
    if (!bake.ok) return fail(bake.dumped)
  }
  return { id: input.id, ok: true, json, ms: Date.now() - started }
}

const ready = newContext()

parentPort?.on('message', (message: WorkerRun | WorkerReset) => {
  void (async () => {
    const started = Date.now()
    try {
      const failed = await ready
      if (failed) throw new Error(`The scene library failed to load: ${failed}`)
      if (message.type === 'reset') {
        const error = await newContext()
        if (error) throw new Error(`The scene library failed to load: ${error}`)
        parentPort?.postMessage({ id: message.id, ok: true, json: null, ms: Date.now() - started } satisfies WorkerReply)
        return
      }
      parentPort?.postMessage(runProgram(message))
    } catch (error) {
      parentPort?.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), line: null, ms: Date.now() - started } satisfies WorkerReply)
    }
  })()
})
