import prelude from './live-prelude.js?raw'
import { STAGE_LIMITS, type StageMode, type StageReply, type StageTiming } from '../shared/stage-protocol'
import { chunkBytes, CREDIT_BYTES, FRAMES_VERSION, FrameEncoder, type MomentsFailure } from '../shared/frames'
import { polylineInk } from '../shared/ink-points'
import { flattenPath, parsePath } from '../shared/path-geometry'
import { mulberry32, SCENE_EASES, trackNumber } from '../shared/live-scene'
import { moduleUrl, programSite, resolveSpecifier, siteLabel, type StageModule, type StageProgram } from '../shared/scene-program'
import { BRIDGE_HEADER, type FromWorker, type ToWorker } from './worker-protocol'

/**
 * The stage's worker: one V8 realm in which every scene program of a board
 * runs (decisions T12, T14). The stage page (page.ts) starts it, and starts a
 * new one for a new context; to stop a program at once, the page ends it
 * (Worker.terminate), so a program may compute as long as it needs.
 *
 * Before the scene library (live-prelude.js) runs, this file takes what it
 * needs itself (the bridge, a clock, eval) and removes every global that is not
 * ECMAScript: no fetch, importScripts, WebSocket, indexedDB, caches, timers,
 * performance, crypto, messaging (postMessage, close, MessageChannel),
 * WebAssembly, Atomics or SharedArrayBuffer, Intl, WeakRef or
 * FinalizationRegistry. The scene library then replaces Date with the scene
 * clock, seeds Math.random and freezes everything a program can reach.
 *
 * The program scheduler is the one QuickJS had: run every pending job, then
 * end the earliest pending action (advance), until nothing waits. V8 runs
 * every pending job (microtask) at the end of each task, so each advance is
 * its own task, posted on a private MessageChannel. A program has no way to
 * make tasks (no timers, no messaging), so nothing else runs between them.
 *
 * A program is a script (inline code with no import or export: the body of
 * an async function, as before modules) or modules (shared/scene-program.ts).
 * Modules run from the snapshot the program carries, never from files: each
 * one is the body of an async function (main/scene-files.ts made it), runs
 * once per program, and runs again for the next program, so no module state
 * carries from one scene to the next (that is what `stage` is for). Module
 * code sees the scene library's globals as inline code does.
 *
 * Host questions (text sizes, html(), space(), items) block: the worker posts
 * the question and waits on the bridge (Atomics.wait) until the page writes
 * the answer (worker-protocol.ts).
 *
 * A program's end (finish): the seeds, then the description, then the sweep.
 * Seeds and samples of the changing objects go as frame chunks (shared/frames.ts)
 * to the page, which passes them to the board. The worker waits while CREDIT_BYTES
 * of frames are on the way. The reply (the description without the samples)
 * comes last. A draft replies before the sweep (sweepOn): the sweep then runs
 * in batches, one tick each, and ends with a terminal message. Between two
 * batches a preview's moments run (moments). A draft with a stepping live item
 * drains first, as a scene does. A rebuild (replay) does not sample: it ends and
 * bakes.
 */

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void
}

interface Host {
  begin(ctxText: string): void
  advance(): boolean
  end(): void
  /** An error of the program's own parallel work (all(), say() marks) as soon as it happens, or null. */
  failed(): { error: unknown } | null
  /** The seeds of the scene: the end state, and the first frames on the board. */
  seeds(): void
  /** The description, built from the end seeds. */
  result(): string
  /** One batch of the sweep, until more() says stop. Null while moments are left, else what the stream's end says. */
  sample(more: () => boolean): { lastChange: Array<[number, number]>; orderDependent: string[]; logs: string[] } | null
  /** Seeds at the given moments, while the sweep runs. An error of a recipe, with its time, or null. */
  seedsAt(times: number[]): { error: unknown; at: number } | null
  /** The scene has an item that integrates its params, so its sweep drains before the reply. */
  stepping(): boolean
  bake(): void
  stats(): { evaluations: number; fullEvaluations: number }
  /** The stage id and key of each object the program made (live-prelude.js keyFor). */
  keys(): Array<[number, string]>
  /** The stage ids the program took, [first, end) (live-prelude.js range). */
  range(): [number, number]
}

const G = globalThis as unknown as Record<PropertyKey, unknown>
const scope = globalThis as unknown as WorkerScope

// ---------- What this file keeps for itself ----------

const post = scope.postMessage.bind(globalThis) as (message: FromWorker, transfer?: Transferable[]) => void
const realEval = G.eval as (code: string) => unknown
const clock = performance.now.bind(performance)
const atomics = Atomics
const decoder = new TextDecoder()
const tick = new MessageChannel()
const { SyntaxError: SyntaxErrorType, Error: ErrorType, Map: MapType, Object: ObjectType, Promise: PromiseType, Symbol: SymbolType, JSON: JSONType } = globalThis

/** The globals that stay: ECMAScript's own (Date and console are replaced by the scene library). */
const KEEP = new Set([
  'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Math', 'JSON', 'Reflect', 'Proxy', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Iterator', 'Date', 'RegExp', 'DisposableStack', 'AsyncDisposableStack',
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'SuppressedError',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'console'
])

let bridge: { state: Int32Array; bytes: Uint8Array } | null = null
let host: Host | null = null
/** While a program's seeds and sweep stream frames: where they go. */
let frameSink: FrameStream | null = null
/** The sweep after a draft's reply, while it runs. */
let sweeping: { fns: Host; id: number; frames: FrameStream } | null = null
/** The board asks the sweep to give way (frames.ts sweepPace). */
let calm = false
/** The longest wait for the board to take frames (it acknowledges each chunk at once). */
const CREDIT_WAIT_MS = 60_000
/** One batch of a sweep after the reply. */
const SWEEP_BATCH_MS = 8
/** While the learner writes or a scene waits in a pause, a sweep takes one short batch per frame: the pen comes first. */
const CALM_BATCH_MS = 2
const CALM_GAP_MS = 14

scope.addEventListener('message', (event) => {
  const message = event.data
  if (message.t === 'init') init(message)
  else if (message.t === 'run') run(message)
  else if (message.t === 'moments') moments(message)
  else if (message.t === 'pace') calm = message.calm
})

/**
 * A promise of the program that rejects with no handler: an async function
 * it started and never awaited (a background loop that throws). Its error is
 * the program's error, as any other: the clock reports it at its next tick.
 * The worker dispatches this event in a task after the one in which the
 * promise rejected (after the tick that task queued), so the clock checks it
 * at every tick and takes one more tick before a program ends.
 */
let unhandled: { error: unknown } | null = null
let running = false
scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  if (running && !unhandled) unhandled = { error: event.reason }
})

// The worker's own globals go before anything else runs; the listener above stays registered.
stripGlobals()

/** Remove every global that is not in KEEP, and empty the global's prototypes (WorkerGlobalScope, EventTarget). */
function stripGlobals(): void {
  for (const key of Reflect.ownKeys(globalThis)) if (!(typeof key === 'string' && KEEP.has(key))) remove(globalThis, key)
  for (let proto = Object.getPrototypeOf(globalThis); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Reflect.ownKeys(proto)) remove(proto, key)
    Object.freeze(proto)
  }
}

/** Delete a property. Only a fixed constant (a number such as TEMPORARY) may stay: it gives a program nothing. */
function remove(owner: object, key: PropertyKey): void {
  if (Reflect.deleteProperty(owner, key)) return
  const d = Reflect.getOwnPropertyDescriptor(owner, key)
  const constant = d && 'value' in d && !d.writable && (d.value === null || (typeof d.value !== 'object' && typeof d.value !== 'function'))
  if (!constant) throw new Error(`The stage could not remove ${String(key)}`)
}

// ---------- The scene library ----------

function init(message: Extract<ToWorker, { t: 'init' }>): void {
  try {
    bridge = { state: new Int32Array(message.bridge, 0, 4), bytes: new Uint8Array(message.bridge) }
    // Deep stacks from a program's line through the scene library (callLine() and error lines need the program's frame).
    ;(Error as unknown as { stackTraceLimit: number }).stackTraceLimit = 50
    G.__fontText = message.fontText
    G.__measure = ask
    G.__frames = (sid: number, kind: string, math: boolean, sample: Record<string, unknown>, seed: boolean): void => frameSink?.add(sid, kind, math, sample, seed)
    G.__framesThrough = (t: number): void => frameSink?.through(t)
    G.__shared = Object.freeze({ parsePath, flattenPath, polylineInk, SCENE_EASES, trackNumber, mulberry32, programSite, siteLabel })
    G.__host = (fns: Host) => {
      host = fns
    }
    if (message.noCodeItems) G.__noCodeItems = true
    if (message.noHtml) G.__noHtml = true
    realEval(`${prelude}\n//# sourceURL=live-prelude.js`)
    if (!host) throw new Error('the scene library gave no host functions')
    post({ t: 'ready' })
  } catch (error) {
    post({ t: 'failed', error: clip(describe(error).message) })
  }
}

/** Ask the board (the main process, through the page); blocks this thread until the answer is there. */
function ask(request: unknown): string {
  if (typeof request !== 'string') throw new TypeError('a host request is text')
  if (request.length > STAGE_LIMITS.host) throw new RangeError('the request to the board is too large')
  const { state, bytes } = bridge as NonNullable<typeof bridge>
  atomics.store(state, 0, 0)
  post({ t: 'host', text: request })
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    atomics.wait(state, 0, 0)
    const length = atomics.load(state, 1)
    const last = atomics.load(state, 2) === 1
    parts.push(bytes.slice(BRIDGE_HEADER, BRIDGE_HEADER + length))
    size += length
    if (last) break
    atomics.store(state, 0, 0)
    post({ t: 'more' })
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return decoder.decode(all)
}

// ---------- One program ----------

function run(message: Extract<ToWorker, { t: 'run' }>): void {
  const started = clock()
  unhandled = null
  const fns = host
  if (!fns) {
    post(failure(message.id, new Error('The scene library is not loaded.'), started))
    return
  }
  try {
    fns.begin(message.ctxText)
  } catch (error) {
    post(failure(message.id, error, started))
    return
  }
  let promise: Promise<unknown>
  try {
    // Same line numbers as the agent's program: the wrapper adds no line before it.
    promise = message.program.kind === 'script' ? (realEval(`(async () => {${message.program.code}\n})()\n//# sourceURL=scene.js`) as Promise<unknown>) : runModules(message.program)
  } catch (error) {
    // Only a parse error is thrown here (an error in the body rejects the promise). V8 does not say where it is.
    if (error instanceof SyntaxErrorType) post({ t: 'parse-error', id: message.id, error: clip(describe(error).message), ms: clock() - started })
    else post(failure(message.id, error, started))
    return
  }
  let settled: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  let reason: unknown
  promise.then(
    () => {
      settled = 'fulfilled'
    },
    (error: unknown) => {
      settled = 'rejected'
      reason = error
    }
  )
  // The clock: each task ends the earliest pending action; every job the program has runs before the next task.
  // A program that fails ends at once: its error goes back now, and no task advances it again, so nothing of it
  // runs any more (its parallel loops included). The next program's begin() drops what it left waiting.
  running = true
  let ending = false
  const stop = (): void => {
    tick.port1.onmessage = null
    running = false
  }
  tick.port1.onmessage = () => {
    const failed = settled === 'rejected' ? { error: reason } : (fns.failed() ?? unhandled)
    if (failed) {
      stop()
      post(failure(message.id, failed.error, started))
      return
    }
    // Nothing was left at the last tick, and nothing failed since: the program ends here (see below).
    if (ending) {
      stop()
      if (settled === 'pending') post(failure(message.id, new ErrorType(STUCK), started))
      else finish(fns, message.id, message.mode, started)
      return
    }
    let more: boolean
    try {
      more = fns.advance()
    } catch (error) {
      stop()
      post(failure(message.id, error, started))
      return
    }
    // Nothing is left on the scene clock: one more task, so that a rejection with no handler from the last tick
    // (its event comes after the task that was queued then) fails the program. Then a program still pending
    // waits on something that never comes.
    if (!more) ending = true
    tick.port2.postMessage(null)
  }
  tick.port2.postMessage(null)
}

/**
 * Run a program's modules: the entry module, which loads the modules it
 * imports (each runs once in this program, when its first importer loads
 * it). Every module is evaluated here and now (no loading, no tasks), so the
 * program runs on the scene clock as a script does.
 *
 * Each module is an async function of its helper (main/scene-files.ts made
 * it): load(path) gives a module's namespace when it has run (a static
 * import); literal(specifier) and dynamic(specifier) are import() with a
 * literal or a computed path; exports(list) gives this module's namespace its
 * getters ([name, getter] pairs, sorted: the namespace reads the module's
 * bindings, live); meta is import.meta.
 */
function runModules(program: Extract<StageProgram, { kind: 'modules' }>): Promise<unknown> {
  const files = new MapType<string, StageModule>()
  for (const module of program.modules) if (module.path !== null) files.set(module.path, module)
  const links = new MapType<string, string>(program.links)
  const loaded = new MapType<string, Promise<object>>()
  const load = (path: string): Promise<object> => {
    const namespace = loaded.get(path)
    if (namespace) return namespace
    const module = files.get(path)
    return module ? evaluate(module) : PromiseType.reject(new ErrorType(`${path} is not one of the files of this scene (they are read at write_scene).`))
  }
  /** import(specifier) from a module: the path it names, through the links write_scene saw. */
  const imported = (from: string | null, specifier: unknown, literal: boolean): Promise<object> => {
    const text = String(specifier)
    const resolved = resolveSpecifier(from, text)
    if ('error' in resolved) return PromiseType.reject(new ErrorType(`import(${JSONType.stringify(text)}): ${resolved.error}.`))
    const path = links.get(resolved.path) ?? resolved.path
    if (files.has(path)) return load(path)
    return PromiseType.reject(
      new ErrorType(
        literal
          ? `import(${JSONType.stringify(text)}): there was no file boards/scenes/${resolved.path} when write_scene read the files of this scene.`
          : `import(${JSONType.stringify(text)}): write_scene did not read boards/scenes/${resolved.path} for this scene. It reads the files that import declarations and import("…") with a literal path name; import() with a computed path loads only one of those files.`
      )
    )
  }
  const evaluate = (module: StageModule): Promise<object> => {
    let body: (helper: object) => Promise<unknown>
    try {
      body = realEval(`${module.code}\n//# sourceURL=${moduleUrl(module.path)}`) as typeof body
    } catch (error) {
      // main parsed every module and its rewrite (main/scene-files.ts); a module V8 refuses still names its file.
      return PromiseType.reject(error instanceof SyntaxErrorType && module.path !== null ? new SyntaxErrorType(`${module.path}: ${error.message}`) : error)
    }
    const namespace = ObjectType.create(null) as Record<PropertyKey, unknown>
    const helper = ObjectType.freeze({
      load,
      literal: (specifier: unknown): Promise<object> => imported(module.path, specifier, true),
      dynamic: (specifier: unknown): Promise<object> => imported(module.path, specifier, false),
      exports: (list: Array<[string, () => unknown]>): void => {
        for (let i = 0; i < list.length; i++) ObjectType.defineProperty(namespace, list[i][0], { get: list[i][1], enumerable: true })
        ObjectType.defineProperty(namespace, SymbolType.toStringTag, { value: 'Module' })
        ObjectType.freeze(namespace)
      },
      meta: ObjectType.freeze({ url: moduleUrl(module.path) })
    })
    // The module is loaded from now on (an import() of it while it runs gets this same evaluation, as in ES).
    let settle: { resolve: (value: object) => void; reject: (reason: unknown) => void } | null = null
    const done = new PromiseType<object>((resolve, reject) => {
      settle = { resolve, reject }
    })
    if (module.path !== null) loaded.set(module.path, done)
    const { resolve, reject } = settle as unknown as { resolve: (value: object) => void; reject: (reason: unknown) => void }
    body(helper).then(() => resolve(namespace), reject)
    return done
  }
  return evaluate(program.modules[0])
}

/**
 * The end of a program that ran: one path for every mode (the cut and the
 * end state). A scene and a draft are seeded, described and swept (their
 * frames go to the board); a scene and a replay bake. A draft replies before
 * its sweep, with the seeds as its first chunk.
 */
function finish(fns: Host, id: number, mode: StageMode, started: number): void {
  const tBody = clock()
  const frames = mode === 'replay' ? null : new FrameStream(id)
  let early = false
  let reply: StageReply
  try {
    fns.end()
    frameSink = frames
    if (frames) fns.seeds()
    const tSeeds = clock()
    let json: string | null = null
    let orderDependent: string[] = []
    if (frames) {
      const description = (): string => {
        const text = fns.result()
        if (typeof text !== 'string' || text.length > STAGE_LIMITS.description) throw new RangeError('the scene description is too large')
        return text
      }
      early = mode === 'draft' && !fns.stepping()
      if (early) {
        json = description()
        frames.send(false)
      } else {
        const swept = fns.sample(() => true) as NonNullable<ReturnType<Host['sample']>>
        orderDependent = swept.orderDependent
        frameSink = null
        // After the sweep: the description then holds the logs of the sweep's recipes too.
        json = description()
        frames.send(true, swept.lastChange)
      }
    }
    const tResult = clock()
    // Before bake: bake turns the objects a cut dropped into gone ones, and keys() leaves the dropped ones out.
    const keys = fns.keys()
    const range = fns.range()
    if (mode !== 'draft') fns.bake()
    const tBake = clock()
    const { evaluations, fullEvaluations } = fns.stats()
    const timing: StageTiming = { body: tBody - started, seeds: tSeeds - tBody, result: tResult - tSeeds, bake: tBake - tResult, evaluations, fullEvaluations, encode: frames?.encodeMs ?? 0, wait: frames?.waitMs ?? 0, bytes: frames?.total ?? 0 }
    reply = { t: 'reply', id, ok: true, json, frames: frames?.sent ?? 0, ms: clock() - started, timing, keys, range, orderDependent, sweeping: early }
  } catch (error) {
    early = false
    reply = failure(id, error, started)
  }
  post(reply)
  if (early) sweepOn(fns, id, frames as FrameStream, started)
  else frameSink = null
}

/**
 * The sweep after a draft's reply: batches of SWEEP_BATCH_MS, with the tick of
 * the program's clock between them, so the worker's message loop runs. While
 * the board asks for calm, the batches are short, with a gap. Each
 * batch ends with a chunk, so the board's coverage moves often. The stream
 * ends with "swept", or a failed reply with the program's id and its cutoff:
 * the last complete moment, which the board has by then.
 */
function sweepOn(fns: Host, id: number, frames: FrameStream, started: number): void {
  const done = (): void => {
    tick.port1.onmessage = null
    frameSink = null
    sweeping = null
  }
  sweeping = { fns, id, frames }
  tick.port1.onmessage = () => {
    try {
      const until = clock() + (calm ? CALM_BATCH_MS : SWEEP_BATCH_MS)
      const swept = fns.sample(() => clock() < until)
      if (!swept) {
        frames.send(false)
        // No question is open during a sweep, so nothing wakes this wait before its time.
        if (calm && bridge) atomics.wait(bridge.state, 0, 0, CALM_GAP_MS)
        tick.port2.postMessage(null)
        return
      }
      done()
      frames.send(true, swept.lastChange)
      post({ t: 'swept', id, frames: frames.sent, ms: clock() - started, orderDependent: swept.orderDependent, logs: swept.logs })
    } catch (error) {
      done()
      try {
        frames.send(false)
      } catch {
        // The board took what it took: the cutoff on the board is the last chunk it has.
      }
      post(failure(id, error, started, frames.reached))
    }
  }
  tick.port2.postMessage(null)
}

/**
 * A preview's moments, between two batches of the sweep: their seeds go to the board at once, then the answer. A sweep that ended
 * has nothing to add: its end reached the board before this answer. A recipe's error goes to the preview, and the sweep goes on.
 */
function moments(message: Extract<ToWorker, { t: 'moments' }>): void {
  let failure: MomentsFailure | null = null
  if (sweeping?.id === message.id) {
    let failed: { error: unknown; at: number } | null
    try {
      failed = sweeping.fns.seedsAt(message.times)
      sweeping.frames.send(false)
    } catch (error) {
      failed = { error, at: message.times[0] }
    }
    if (failed) {
      const { message: error, line, file } = describe(failed.error)
      failure = { error: clip(error), line, file, at: failed.at }
    }
  }
  post({ t: 'moments', id: message.id, ask: message.ask, failure })
}

/**
 * The frames of one program: encoded as the sampling makes them, and sent in
 * chunks as the board's credits allow. A chunk is at most CHUNK_BYTES and one sample.
 */
class FrameStream {
  private readonly encoder = new FrameEncoder()
  /** The last moment sampled whole. */
  reached = 0
  sent = 0
  total = 0
  encodeMs = 0
  waitMs = 0

  constructor(private readonly id: number) {}

  add(sid: number, kind: string, math: boolean, sample: Record<string, unknown>, seed: boolean): void {
    const t0 = clock()
    this.encoder.add(sid, kind, math, sample, seed)
    this.encodeMs += clock() - t0
    if (this.encoder.full()) this.send(false)
  }

  through(t: number): void {
    this.reached = t
  }

  send(end: boolean, lastChange: Array<[number, number]> = []): void {
    const chunk = this.encoder.take()
    const bytes = chunkBytes(chunk)
    this.total += bytes
    const { state } = bridge as NonNullable<typeof bridge>
    const t0 = clock()
    // Wait while this chunk would take the bytes on the way over the credit. With nothing on the way it goes
    // (only a single sample larger than the credit can make a chunk that large).
    for (;;) {
      const inFlight = atomics.load(state, 3)
      if (inFlight === 0 || inFlight + bytes <= CREDIT_BYTES) break
      if (atomics.wait(state, 3, inFlight, CREDIT_WAIT_MS) === 'timed-out') throw new Error('The board did not take the frames of the scene.')
    }
    this.waitMs += clock() - t0
    atomics.add(state, 3, bytes)
    post({ t: 'frames', v: FRAMES_VERSION, id: this.id, seq: this.sent++, through: this.reached, end, lastChange, u32: chunk.u32, f64: chunk.f64, strings: chunk.strings }, [chunk.u32.buffer, chunk.f64.buffer])
  }
}

/** The error of a program that waits when nothing is left to happen on the scene clock. */
const STUCK = 'The program did not finish: it waits on something that never happens, such as an await on a promise that nothing resolves.'

function failure(id: number, thrown: unknown, started: number, at?: number): StageReply {
  const { message, line, file } = describe(thrown)
  return { t: 'reply', id, ok: false, error: clip(message), line, file, ms: clock() - started, ...(at !== undefined ? { at } : {}) }
}

/** An error's text and where in the agent's code it came from (the innermost frame in a module or the inline code). */
function describe(thrown: unknown): { message: string; line: number | null; file: string | null } {
  try {
    if (thrown && typeof thrown === 'object') {
      const error = thrown as { name?: unknown; message?: unknown; stack?: unknown }
      const site = programSite(String(error.stack ?? ''))
      return { message: `${String(error.name ?? 'Error')}: ${String(error.message ?? thrown)}`, line: site?.line ?? null, file: site?.file ?? null }
    }
    return { message: String(thrown), line: null, file: null }
  } catch {
    return { message: 'The program threw a value that cannot be shown as text.', line: null, file: null }
  }
}

const clip = (text: string): string => (text.length > STAGE_LIMITS.error ? `${text.slice(0, STAGE_LIMITS.error - 1)}…` : text)
