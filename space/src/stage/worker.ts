import prelude from './live-prelude.js?raw'
import { STAGE_LIMITS, type StageMode, type StageReply, type StageTiming } from '../shared/stage-protocol'
import { chunkBytes, CREDIT_BYTES, FRAMES_VERSION, FrameEncoder, MAX_FRAME_BYTES } from '../shared/frames'
import { polylineInk } from '../shared/ink-points'
import { flattenPath, parsePath } from '../shared/path-geometry'
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
 * Host questions (text sizes, html(), space(), items) block: the worker posts
 * the question and waits on the bridge (Atomics.wait) until the page writes
 * the answer (worker-protocol.ts).
 *
 * A program's end (finish): the sampling pass streams each changing
 * object's samples as frame chunks (shared/frames.ts) to the page, which
 * passes them to the board. The worker waits while CREDIT_BYTES of frames are
 * on the way. The reply (the description without the samples) comes last. A
 * rebuild (replay) does not sample: it ends and bakes.
 */

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void
}

interface Host {
  begin(ctxText: string): void
  advance(): boolean
  end(): void
  result(): string
  bake(): void
  stats(): { evaluations: number; fullEvaluations: number }
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
const { SyntaxError: SyntaxErrorType } = globalThis

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
/** While a program's sampling pass streams frames: where each object's samples go. */
let frameSink: ((sid: number, kind: string, math: boolean, samples: Array<Record<string, unknown>>) => void) | null = null
/** The longest wait for the board to take frames (it acknowledges each chunk at once). */
const CREDIT_WAIT_MS = 60_000

scope.addEventListener('message', (event) => {
  const message = event.data
  if (message.t === 'init') init(message)
  else if (message.t === 'run') run(message)
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
    G.__frames = (sid: number, kind: string, math: boolean, samples: Array<Record<string, unknown>>): void => {
      if (frameSink) frameSink(sid, kind, math, samples)
    }
    G.__geometry = Object.freeze({ parsePath, flattenPath, polylineInk })
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
    promise = realEval(`(async () => {${message.code}\n})()\n//# sourceURL=scene.js`) as Promise<unknown>
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
  tick.port1.onmessage = () => {
    let more: boolean
    try {
      more = fns.advance()
    } catch (error) {
      tick.port1.onmessage = null
      post(failure(message.id, error, started))
      return
    }
    if (more) {
      tick.port2.postMessage(null)
      return
    }
    tick.port1.onmessage = null
    // A pending promise here waits on something that never resolves (not a scene action): the scene ends there.
    if (settled === 'rejected') post(failure(message.id, reason, started))
    else post(finish(fns, message.id, message.mode, started))
  }
  tick.port2.postMessage(null)
}

/**
 * The end of a program that ran: one path for every mode (the cut and the
 * end state). A scene and a draft are sampled (their frames go to the board)
 * and described; a scene and a replay bake.
 */
function finish(fns: Host, id: number, mode: StageMode, started: number): StageReply {
  const tBody = clock()
  const frames = mode === 'replay' ? null : new FrameStream(id)
  try {
    fns.end()
    let json: string | null = null
    if (frames) {
      frameSink = (sid, kind, math, samples) => frames.add(sid, kind, math, samples)
      json = fns.result()
      frameSink = null
      frames.flush()
      if (typeof json !== 'string' || json.length > STAGE_LIMITS.description) throw new RangeError('the scene description is too large')
    }
    const tResult = clock()
    if (mode !== 'draft') fns.bake()
    const tBake = clock()
    const { evaluations, fullEvaluations } = fns.stats()
    const timing: StageTiming = { body: tBody - started, result: tResult - tBody, bake: tBake - tResult, evaluations, fullEvaluations, encode: frames?.encodeMs ?? 0, wait: frames?.waitMs ?? 0, bytes: frames?.total ?? 0 }
    return { t: 'reply', id, ok: true, json, frames: frames?.sent ?? 0, ms: clock() - started, timing }
  } catch (error) {
    return failure(id, error, started)
  } finally {
    frameSink = null
  }
}

/**
 * The frames of one program: encoded as the sampling makes them, and sent in
 * chunks as the board's credits allow. The encoder splits a large object
 * into several records, so a chunk is at most CHUNK_BYTES and one sample.
 */
class FrameStream {
  private readonly encoder = new FrameEncoder(() => this.flush())
  sent = 0
  total = 0
  encodeMs = 0
  waitMs = 0

  constructor(private readonly id: number) {}

  add(sid: number, kind: string, math: boolean, samples: Array<Record<string, unknown>>): void {
    const t0 = clock()
    const waited = this.waitMs
    this.encoder.add(sid, kind, math, samples)
    this.encodeMs += clock() - t0 - (this.waitMs - waited)
  }

  flush(): void {
    if (this.encoder.empty) return
    const chunk = this.encoder.take()
    const bytes = chunkBytes(chunk)
    this.total += bytes
    if (this.total > MAX_FRAME_BYTES) throw new RangeError(`the frames of the scene are larger than ${MAX_FRAME_BYTES / 1024 / 1024} MB`)
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
    post({ t: 'frames', v: FRAMES_VERSION, id: this.id, seq: this.sent++, u32: chunk.u32, f64: chunk.f64, strings: chunk.strings }, [chunk.u32.buffer, chunk.f64.buffer])
  }
}

function failure(id: number, thrown: unknown, started: number): StageReply {
  const { message, line } = describe(thrown)
  return { t: 'reply', id, ok: false, error: clip(message), line, ms: clock() - started }
}

/** An error's text and the program line it came from (the innermost scene.js frame). */
function describe(thrown: unknown): { message: string; line: number | null } {
  try {
    if (thrown && typeof thrown === 'object') {
      const error = thrown as { name?: unknown; message?: unknown; stack?: unknown }
      const match = /scene\.js:(\d+)/.exec(String(error.stack ?? ''))
      return { message: `${String(error.name ?? 'Error')}: ${String(error.message ?? thrown)}`, line: match ? Number(match[1]) : null }
    }
    return { message: String(thrown), line: null }
  } catch {
    return { message: 'The program threw a value that cannot be shown as text.', line: null }
  }
}

const clip = (text: string): string => (text.length > STAGE_LIMITS.error ? `${text.slice(0, STAGE_LIMITS.error - 1)}…` : text)
