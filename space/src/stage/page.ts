import { chunkBytes, type FramesChunk } from '../shared/frames'
import type { StageProgram } from '../shared/scene-program'
import { parseReply, parseToStage, refusedHostId, refusedId, STAGE_LIMITS, type FromStage, type StageReply, type ToStage } from '../shared/stage-protocol'
import { BRIDGE_CHUNK, BRIDGE_HEADER, type FromWorker, type ToWorker } from './worker-protocol'

/**
 * The stage page: the hidden, sandboxed page of the stage process
 * (main/stage-process.ts). It runs no program itself. It holds the worker
 * whose realm is the stage (worker.ts), relays between that worker and the
 * main process, and writes the board's answers into the worker's bridge.
 *
 * The page gets its one MessagePort to the main process from the stage
 * preload (preload/stage.ts) and checks every message on it
 * (shared/stage-protocol.ts); it checks every message from the worker too.
 *
 * The frames of a program (shared/frames.ts) do not go through the main
 * process: the preload also hands over a second port, whose other end is in
 * the board renderer (main/live-scene.ts links them). The page passes each
 * chunk on (its buffers transferred), and gives the worker its bytes back
 * (the bridge's credit) when the board acknowledges the chunk. The reply of
 * a program waits until the board has acknowledged every chunk, so when the
 * main process has the reply, the board has the frames.
 */

interface Context {
  worker: Worker
  state: Int32Array
  bytes: Uint8Array
  ready: boolean
  /** The reset that waits for this context to be ready. */
  resetId: number | null
  /** The program that runs now (a script's code finds the line of a parse error). */
  run: { id: number; program: StageProgram } | null
  /** The host question the worker waits on now, and the rest of its answer. */
  hostId: number | null
  answer: { data: Uint8Array; at: number } | null
  /** The frame chunks of the program that the board has not acknowledged yet (seq → bytes), and whether it sent any. */
  outstanding: Map<number, number>
  streamed: boolean
  /** The program's reply, held until the board has acknowledged every chunk. */
  held: StageReply | null
}

let port: MessagePort | null = null
/** The port to the board renderer for frames (null until main links one). */
let frames: MessagePort | null = null
let config: Extract<ToStage, { t: 'init' }> | null = null
let current: Context | null = null
let nextHostId = 1
/** The longest wait for the board's acknowledgements after a program's last chunk. */
const HELD_REPLY_MS = 30_000
const encoder = new TextEncoder()

const send = (message: FromStage): void => port?.postMessage(message)

window.addEventListener('message', (event) => {
  if (event.ports.length !== 1) return
  if (event.data === 'frames-port' && port) {
    linkFrames(event.ports[0])
    return
  }
  if (port || event.data !== 'stage-port') return
  port = event.ports[0]
  port.onmessage = (incoming) => {
    const message = parseToStage(incoming.data)
    if (message) handle(message)
    else refused(incoming.data)
  }
  send({ t: 'ready' })
})

/**
 * A message from main that the parser refused. Nothing may wait on it forever: a run or a reset gets a failed reply with
 * its id, and an answer the worker waits on becomes an error answer.
 */
function refused(data: unknown): void {
  const id = refusedId(data)
  if (id !== null) {
    send({ t: 'reply', id, ok: false, error: 'The stage refused the program: the message was of the wrong shape or larger than the stage takes.', line: null, file: null, ms: 0 })
    return
  }
  const hid = refusedHostId(data)
  if (hid !== null && current?.hostId === hid) handle({ t: 'answer', hid, text: JSON.stringify({ error: "The board's answer was of the wrong shape or larger than the stage takes." }) })
}

/** A new port to the board. A program that streams frames to the old one fails (its frames are lost). */
function linkFrames(next: MessagePort): void {
  frames?.close()
  frames = next
  frames.onmessage = (incoming) => onAck(incoming.data)
  const run = current?.run
  if (current && run && current.streamed) {
    stop()
    send({ t: 'reply', id: run.id, ok: false, error: 'The board window loaded again while the scene was sampled.', line: null, file: null, ms: 0 })
  }
  send({ t: 'linked' })
}

/** The board acknowledges a chunk: its bytes go back to the worker's credit; the held reply goes once every chunk is acknowledged. */
function onAck(data: unknown): void {
  if (typeof data !== 'object' || data === null) return
  const m = data as Record<string, unknown>
  if (m.t !== 'ack' || typeof m.job !== 'number' || typeof m.seq !== 'number') return
  const context = current
  if (!context || !context.run || context.run.id !== m.job) return
  const bytes = context.outstanding.get(m.seq)
  if (bytes === undefined) return
  context.outstanding.delete(m.seq)
  Atomics.sub(context.state, 3, bytes)
  Atomics.notify(context.state, 3)
  if (context.held && !context.outstanding.size) {
    const reply = context.held
    context.held = null
    context.run = null
    send(reply)
  }
}

/** The board can drop the frames of a program that did not end well. */
function retire(context: Context): void {
  if (context.run && context.streamed) frames?.postMessage({ t: 'retire', job: context.run.id })
}

function handle(message: ToStage): void {
  switch (message.t) {
    case 'init':
      config = message
      return
    case 'reset':
      start(message.id)
      return
    case 'run':
      if (!current || !current.ready || current.run) {
        send({ t: 'reply', id: message.id, ok: false, error: current?.run ? 'Another program runs on the stage.' : 'The stage has no context.', line: null, file: null, ms: 0 })
        return
      }
      current.run = { id: message.id, program: message.program }
      current.streamed = false
      current.outstanding.clear()
      current.held = null
      current.worker.postMessage({ t: 'run', id: message.id, program: message.program, ctxText: message.ctxText, mode: message.mode } satisfies ToWorker)
      return
    case 'answer':
      if (!current || current.hostId !== message.hid) return
      current.hostId = null
      current.answer = { data: encoder.encode(message.text), at: 0 }
      writeChunk(current)
      return
    case 'cancel':
      stop()
      return
  }
}

/** A new context: the old worker ends, a new one loads the scene library. */
function start(resetId: number): void {
  stop()
  if (!config) {
    send({ t: 'reply', id: resetId, ok: false, error: 'The stage page has no settings.', line: null, file: null, ms: 0 })
    return
  }
  const started = performance.now()
  const bridge = new SharedArrayBuffer(BRIDGE_HEADER + BRIDGE_CHUNK)
  const worker = new Worker('worker.js', { name: 'stage' })
  const context: Context = { worker, state: new Int32Array(bridge, 0, 4), bytes: new Uint8Array(bridge), ready: false, resetId, run: null, hostId: null, answer: null, outstanding: new Map(), streamed: false, held: null }
  current = context
  worker.addEventListener('message', (event) => {
    if (current === context) fromWorker(context, event.data, started)
  })
  const broken = (text: string): void => {
    if (current !== context) return
    const id = context.resetId ?? context.run?.id ?? null
    stop()
    if (id !== null) send({ t: 'reply', id, ok: false, error: text, line: null, file: null, ms: performance.now() - started })
  }
  worker.addEventListener('error', (event) => {
    event.preventDefault()
    broken(`The stage failed: ${event.message || 'an error in its worker'}`)
  })
  worker.addEventListener('messageerror', () => broken('The stage failed: a message could not be read.'))
  worker.postMessage({ t: 'init', fontText: config.fontText, noCodeItems: config.noCodeItems, noHtml: config.noHtml, bridge } satisfies ToWorker)
}

function stop(): void {
  if (current) {
    retire(current)
    current.worker.terminate()
  }
  current = null
}

function fromWorker(context: Context, data: unknown, started: number): void {
  const message = parseFromWorker(data)
  if (!message) {
    // A message the page cannot read: what waits on this worker fails now (it would wait forever).
    const id = context.resetId ?? context.run?.id ?? null
    if (id === null) return
    stop()
    send({ t: 'reply', id, ok: false, error: 'The stage failed: its worker sent a message of the wrong shape or larger than the stage takes.', line: null, file: null, ms: performance.now() - started })
    return
  }
  switch (message.t) {
    case 'ready':
    case 'failed':
      if (context.resetId === null) return
      context.ready = message.t === 'ready'
      send(message.t === 'ready' ? { t: 'reply', id: context.resetId, ok: true, json: null, frames: 0, ms: performance.now() - started, timing: null, keys: null } : { t: 'reply', id: context.resetId, ok: false, error: `The scene library failed to load: ${message.error}`, line: null, file: null, ms: performance.now() - started })
      context.resetId = null
      if (!context.ready) stop()
      return
    case 'reply':
      if (!context.run || context.run.id !== message.id) return
      if (message.ok && context.outstanding.size) {
        context.held = message
        // The board acknowledges each chunk at once; a board that does not answer must not hold the stage.
        const run = context.run
        setTimeout(() => {
          if (current !== context || context.held !== message || context.run !== run) return
          stop()
          send({ t: 'reply', id: message.id, ok: false, error: 'The board did not take the frames of the scene.', line: null, file: null, ms: performance.now() - started })
        }, HELD_REPLY_MS)
        return
      }
      if (!message.ok) retire(context)
      context.run = null
      send(message)
      return
    case 'frames': {
      const run = context.run
      if (!run || run.id !== message.id) return
      if (!frames) {
        stop()
        send({ t: 'reply', id: run.id, ok: false, error: 'The stage has no connection to the board for the frames of the scene.', line: null, file: null, ms: performance.now() - started })
        return
      }
      context.streamed = true
      context.outstanding.set(message.seq, chunkBytes(message))
      const chunk: FramesChunk = { t: 'frames', v: message.v, job: run.id, seq: message.seq, u32: message.u32, f64: message.f64, strings: message.strings }
      frames.postMessage(chunk, [message.u32.buffer, message.f64.buffer])
      return
    }
    case 'parse-error': {
      const run = context.run
      if (!run || run.id !== message.id) return
      void (run.program.kind === 'script' ? syntaxLine(run.program.code) : Promise.resolve(null)).then((line) => {
        if (context.run !== run) return
        context.run = null
        send({ t: 'reply', id: message.id, ok: false, error: message.error, line, file: null, ms: message.ms })
      })
      return
    }
    case 'host':
      // The worker asks only while a program runs, and one question at a time.
      if (!context.run || context.hostId !== null || context.answer) {
        stop()
        send({ t: 'reply', id: context.run?.id ?? 0, ok: false, error: 'The stage failed: a question to the board came out of turn.', line: null, file: null, ms: performance.now() - started })
        return
      }
      context.hostId = nextHostId++
      send({ t: 'host', hid: context.hostId, text: message.text })
      return
    case 'more':
      if (context.answer) writeChunk(context)
      return
  }
}

/** Write the next chunk of the answer into the bridge and wake the worker. */
function writeChunk(context: Context): void {
  const answer = context.answer as NonNullable<Context['answer']>
  const length = Math.min(BRIDGE_CHUNK, answer.data.length - answer.at)
  context.bytes.set(answer.data.subarray(answer.at, answer.at + length), BRIDGE_HEADER)
  answer.at += length
  const last = answer.at >= answer.data.length
  if (last) context.answer = null
  Atomics.store(context.state, 1, length)
  Atomics.store(context.state, 2, last ? 1 : 0)
  Atomics.store(context.state, 0, 1)
  Atomics.notify(context.state, 0)
}

/**
 * The line of a parse error. V8 gives a script's parse error position only to
 * the script's error event, so a throwaway worker loads the program as a
 * script of its own, behind `throw 0;` on the first line: nothing in it ever
 * runs (a script is parsed completely before its first statement runs, and
 * the first statement throws). Its error event names the line.
 */
function syntaxLine(code: string): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([`throw 0;\n(async () => {${code}\n})()`], { type: 'text/javascript' }))
    const worker = new Worker(url, { name: 'stage-parse' })
    worker.addEventListener('error', (event) => {
      event.preventDefault()
      worker.terminate()
      URL.revokeObjectURL(url)
      resolve(event.lineno > 1 ? event.lineno - 1 : null)
    })
  })
}

function parseFromWorker(value: unknown): FromWorker | null {
  if (typeof value !== 'object' || value === null) return null
  const m = value as Record<string, unknown>
  switch (m.t) {
    case 'ready':
    case 'more':
      return { t: m.t }
    case 'failed':
      return typeof m.error === 'string' ? { t: 'failed', error: m.error.slice(0, STAGE_LIMITS.error) } : null
    case 'reply':
      return parseReply(value) as StageReply | null
    case 'parse-error':
      return typeof m.id === 'number' && typeof m.error === 'string' && typeof m.ms === 'number' ? { t: 'parse-error', id: m.id, error: m.error.slice(0, STAGE_LIMITS.error), ms: m.ms } : null
    case 'host':
      return typeof m.text === 'string' && m.text.length <= STAGE_LIMITS.host ? { t: 'host', text: m.text } : null
    case 'frames': {
      const ok =
        typeof m.v === 'number' &&
        typeof m.id === 'number' &&
        typeof m.seq === 'number' &&
        Number.isSafeInteger(m.seq) &&
        m.u32 instanceof Uint32Array &&
        m.f64 instanceof Float64Array &&
        Array.isArray(m.strings) &&
        (m.strings as unknown[]).every((text) => typeof text === 'string' && text.length <= STAGE_LIMITS.description)
      return ok ? { t: 'frames', v: m.v as number, id: m.id as number, seq: m.seq as number, u32: m.u32 as Uint32Array, f64: m.f64 as Float64Array, strings: m.strings as string[] } : null
    }
    default:
      return null
  }
}
