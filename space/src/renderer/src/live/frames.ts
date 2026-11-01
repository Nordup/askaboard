import { chunkBytes, F_ALL, F_D, F_FORM, F_JSON, F_LINES, F_PARAMS, F_TEXT, F_WIDTH, FLAG_MATH, FLAG_SEED, FRAME_KINDS, FRAMES_VERSION, type FrameKind, type FramesChunk, type MomentsAnswer, type MomentsAsk, type MomentsFailure } from '@shared/frames'
import type { SceneSample } from '@shared/live-scene'
import { prepareSample, sampleHtml, splitNumbers, type DynSample, type PlayDyn } from './compile'
import { scenePlayer } from './player'

/**
 * The board's end of the frames port (shared/frames.ts). The stage page
 * sends the frames of a program here directly while its sampling pass runs;
 * each chunk is decoded at once into the samples that playback uses, and
 * acknowledged (the stage then sends more). The main process names the
 * frames by their job id when it hands over the description (sceneDraft,
 * runScene: run.ts takeFrames). The page sends the reply of a program to
 * the main process only after every chunk is acknowledged, so the frames are
 * here by then.
 *
 * A job is open while it receives: each chunk adds samples to its objects, and
 * moves readyThrough. Its last chunk ends it, and it is then complete: the
 * scene's whole duration is here. A job that stops before that ends with a
 * cutoff, its last complete moment: samples past it go, and each live form ends
 * there, so no read blends toward a partial moment.
 *
 * One owner: this store until takeFrames, then the compile (and its play),
 * which holds the job's live objects. The store keeps a taken job only to
 * find it for its chunks, until it ends. The stage runs one program at a time,
 * so a chunk of a newer job drops older jobs that nothing took. A chunk out of
 * order, of another version or with a wrong value spoils its job: takeFrames
 * fails, and a job already taken ends there.
 */

/** The seeds and the samples of one object, by its stage id. */
export interface ObjectFrames {
  kind: FrameKind
  math: boolean
  /** What write_scene ran: the moments that a read past the sweep uses. */
  seeds: DynSample[]
  /** The sweep's samples. */
  samples: DynSample[]
  /** The time of its last sample that differs from the one before; Infinity until the stream's end says. */
  lastChange: number
  /** The object's path forms (one parts array per form, across chunks). */
  forms: Map<string, readonly string[]>
  /** The live forms that compiles made of it: the job's end sets their `end`. */
  dyns: PlayDyn[]
}

/** The frames of a run: by stage object id, and their size. The compile holds this live object. */
export interface RunFrames {
  objects: Map<number, ObjectFrames>
  bytes: number
  /** The last chunk is here, or the stream was cut. */
  ended: boolean
  /** Why the stream stopped before the end, or null. */
  stopped: () => StreamStop | null
  /** How far it can play: Infinity after the end. */
  ready: () => number
  /** Makes the given moments readable: the stage seeds those past ready() while the sweep runs. Resolves when they are here or the stream ended, with a recipe's error at one of them. */
  moments: (times: number[]) => Promise<MomentsFailure | null>
}

/**
 * A stream that stopped before its end. at: its cutoff, the last complete moment. failed: the sweep failed, so a
 * run of the same program gives no more. Else it was cut (a cancel, a crash, a window reload): a new run gives the whole stream.
 */
export interface StreamStop {
  at: number
  failed: boolean
}

interface JobFrames extends RunFrames {
  /** The next chunk expected. */
  next: number
  /** Every moment up to this time is complete on the board. */
  readyThrough: number
  stop: StreamStop | null
  /** A compile holds it (takeFrames). */
  taken: boolean
  /** ms spent decoding, and the longest chunk. */
  ms: number
  longest: number
  error: string | null
  /** The previews that wait for an answer of the stage, by their ask. */
  asks: Map<number, (failure: MomentsFailure | null) => void>
}

function newJob(id: number): JobFrames {
  const job: JobFrames = {
    next: 0,
    objects: new Map(),
    readyThrough: 0,
    ended: false,
    stop: null,
    taken: false,
    bytes: 0,
    ms: 0,
    longest: 0,
    error: null,
    asks: new Map(),
    stopped: () => job.stop,
    ready: () => (job.ended ? Number.POSITIVE_INFINITY : job.readyThrough),
    moments: (times) => {
      const past = times.filter((t) => t > job.ready())
      if (!past.length || !port) return Promise.resolve(null)
      const ask = ++lastAsk
      port.postMessage({ t: 'moments', job: id, ask, times: past } satisfies MomentsAsk)
      return new Promise((resolve) => job.asks.set(ask, resolve))
    }
  }
  return job
}

const newObject = (kind: FrameKind, math: boolean): ObjectFrames => ({ kind, math, seeds: [], samples: [], lastChange: Number.POSITIVE_INFINITY, forms: new Map(), dyns: [] })

/** The live entry of an object of a job that is open: its samples can start to arrive after the compile. */
export function objectOf(frames: RunFrames, sid: number, kind: FrameKind, math: boolean): ObjectFrames {
  let entry = frames.objects.get(sid)
  if (!entry) frames.objects.set(sid, (entry = newObject(kind, math)))
  return entry
}

/**
 * The end of a job. Complete: each live form takes its last change, and an object with no samples shows as committed.
 * Stopped: each live form ends at the cutoff at the latest. A play of it updates its settled times and units from here
 * (scenePlayer.playsChanged); a scene whose stream was cut no longer counts as held (scenePlayer.forgetCut).
 */
function endJob(id: number, job: JobFrames, stop: { failed: boolean } | null): void {
  if (job.ended) return
  job.ended = true
  const at = job.readyThrough
  if (stop) job.stop = { at, failed: stop.failed }
  for (const entry of job.objects.values()) {
    if (stop) {
      while (entry.samples.length && entry.samples[entry.samples.length - 1].t > at) entry.samples.pop()
      entry.lastChange = Math.min(entry.lastChange, at)
    }
    for (const dyn of entry.dyns) if (Number.isFinite(dyn.end)) dyn.end = stop ? Math.min(dyn.end, at) : entry.samples.length ? Math.min(dyn.end, entry.lastChange) : Number.NEGATIVE_INFINITY
  }
  // Nothing more comes: each stopped moment is past the cutoff (sceneFrames), and the rest are here.
  for (const resolve of job.asks.values()) resolve(null)
  job.asks.clear()
  if (!job.taken) return
  jobs.delete(id)
  scenePlayer.playsChanged()
  if (stop && !stop.failed) scenePlayer.forgetCut()
}

/** The stream of `job` stopped before its end: nothing waits for it any more. */
export function cutJob(id: unknown, failed = false): void {
  const job = typeof id === 'number' ? jobs.get(id) : undefined
  if (job) endJob(id as number, job, { failed })
}

/** Called as a stream grows: the owner of the scene budget (run.ts) trims what no longer plays. */
let growth: (() => void) | null = null
export function onFramesGrowth(listener: () => void): void {
  growth = listener
}

let port: MessagePort | null = null
const jobs = new Map<number, JobFrames>()
let lastAsk = 0

function onWindowMessage(event: MessageEvent): void {
  // Only this window's own preload hands over the port. Worlds run in an iframe of this window that can post to
  // it, but its messages have their own window as the source, so they cannot replace the stage port.
  if (event.source !== window || event.data !== 'ls-frames-port' || event.ports.length !== 1) return
  port?.close()
  for (const id of [...jobs.keys()]) cutJob(id)
  jobs.clear()
  port = event.ports[0]
  port.onmessage = (incoming) => onPortMessage(incoming.data)
}

/** Ask the main process for a port to the stage (once per load of this window; a new port makes the stage end a program that streams). */
export function connectFrames(): void {
  const space = (window as unknown as { space?: { framesPort?: () => void } }).space
  if (!space?.framesPort) return
  window.addEventListener('message', onWindowMessage)
  space.framesPort()
}

if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('message', onWindowMessage))

function onPortMessage(data: unknown): void {
  if (typeof data !== 'object' || data === null) return
  const m = data as Record<string, unknown>
  if (m.t === 'retire' && typeof m.job === 'number') {
    cutJob(m.job, m.failed === true)
    // A failed sweep can end before the draft takes its frames: they stay for takeFrames.
    if (m.failed !== true) jobs.delete(m.job)
    return
  }
  if (m.t === 'moments') {
    const { job, ask, failure } = m as unknown as MomentsAnswer
    const frames = jobs.get(job)
    frames?.asks.get(ask)?.(failure)
    frames?.asks.delete(ask)
    return
  }
  if (m.t !== 'frames' || typeof m.job !== 'number' || typeof m.seq !== 'number') return
  const job = m.job
  let frames = jobs.get(job)
  if (!frames) {
    for (const [id, older] of jobs) if (id < job && !older.taken) jobs.delete(id)
    frames = newJob(job)
    jobs.set(job, frames)
  }
  if (frames.error === null) {
    try {
      if (m.v !== FRAMES_VERSION) throw new Error(`frames of version ${String(m.v)} (this board reads ${FRAMES_VERSION})`)
      if (m.seq !== frames.next) throw new Error(`chunk ${m.seq} came where chunk ${frames.next} was due`)
      if (typeof m.through !== 'number' || !(m.through >= frames.readyThrough) || typeof m.end !== 'boolean') throw new Error('a chunk with a wrong coverage')
      if (!Array.isArray(m.lastChange) || !(m.u32 instanceof Uint32Array) || !(m.f64 instanceof Float64Array) || !Array.isArray(m.strings) || !m.strings.every((text) => typeof text === 'string')) throw new Error('a chunk of the wrong shape')
      const chunk = m as unknown as FramesChunk
      const t0 = performance.now()
      decode(chunk, frames.objects)
      const ms = performance.now() - t0
      frames.ms += ms
      frames.longest = Math.max(frames.longest, ms)
      frames.bytes += chunkBytes(chunk)
      growth?.()
      frames.next++
      frames.readyThrough = chunk.through
      if (chunk.end) endJob(job, frames, null)
    } catch (error) {
      frames.error = error instanceof Error ? error.message : String(error)
      endJob(job, frames, { failed: false })
    }
  }
  port?.postMessage({ t: 'ack', job, seq: m.seq })
}

/**
 * The frames of run `job`: the live job, whose first `chunks` chunks are here (the rest of an open job
 * arrives after this). Throws when they are not, or one could not be read.
 */
export function takeFrames(job: unknown, chunks: unknown): RunFrames {
  if (typeof job !== 'number' || typeof chunks !== 'number') throw new Error('The scene came without its frames.')
  const frames = jobs.get(job)
  if (!frames) throw new Error('The board does not have the frames of the scene (the board window loaded again?). Write the scene again.')
  if (frames.error || frames.next < chunks) jobs.delete(job)
  if (frames.error) throw new Error(`The frames of the scene could not be read: ${frames.error}`)
  if (frames.next < chunks) throw new Error(`The board has ${frames.next} of the ${chunks} frame chunks of the scene.`)
  frames.taken = true
  if (frames.ended) jobs.delete(job)
  console.log(`frames: job ${job}: ${chunks} chunks, ${(frames.bytes / 1024 / 1024).toFixed(2)} MB, decoded in ${Math.round(frames.ms)} ms (longest chunk ${Math.round(frames.longest)} ms)${frames.ended ? '' : ', open'}`)
  return frames
}

/** Add a sample to its list. A seed that a preview asked for can fall between earlier seeds: seeds stay in time order. */
function keep(list: DynSample[], sample: DynSample, seed: boolean): void {
  if (!seed) {
    list.push(sample)
    return
  }
  let at = list.length
  while (at > 0 && list[at - 1].t > sample.t) at--
  list.splice(at, 0, sample)
}

const NO_LINES = { xy: new Float64Array(0), ends: new Uint32Array(0) }

/** Decode one chunk. Each record adds one sample to its object. */
function decode(chunk: FramesChunk, objects: Map<number, ObjectFrames>): void {
  const { u32, f64, strings } = chunk
  let u = 0
  let f = 0
  const U = (): number => {
    if (u >= u32.length) throw new Error('a chunk ends too early')
    return u32[u++]
  }
  const F = (): number => {
    if (f >= f64.length) throw new Error('a chunk ends too early')
    const value = f64[f++]
    if (!Number.isFinite(value)) throw new Error('a number that is not finite')
    return value
  }
  /** The next n numbers, in the chunk's own buffer: the sample holds no copy. */
  const run = (n: number): Float64Array => {
    if (f + n > f64.length) throw new Error('a chunk ends too early')
    const numbers = f64.subarray(f, f + n)
    for (let k = 0; k < n; k++) if (!Number.isFinite(numbers[k])) throw new Error('a number that is not finite')
    f += n
    return numbers
  }
  const S = (): string => {
    const index = U()
    if (index >= strings.length) throw new Error('a text index outside the table')
    return strings[index]
  }
  const records = U()
  for (let r = 0; r < records; r++) {
    const sid = U()
    const kind = FRAME_KINDS[U()]
    if (kind === undefined) throw new Error('an unknown kind of object')
    const flags = U()
    const math = (flags & FLAG_MATH) !== 0
    let entry = objects.get(sid)
    if (!entry) objects.set(sid, (entry = newObject(kind, math)))
    else if (entry.kind !== kind || entry.math !== math) throw new Error('a record that does not fit its object')
    const { forms } = entry
    const seed = (flags & FLAG_SEED) !== 0
    const samples = seed ? entry.seeds : entry.samples
    const mask = U()
    if (mask & ~F_ALL) throw new Error('an unknown field')
    if (mask & F_JSON) {
      if (mask !== F_JSON) throw new Error('a JSON sample with other fields')
      keep(samples, prepareSample(kind, math, JSON.parse(S()) as SceneSample, forms), seed)
      continue
    }
    const allowed = kind === 'shape' ? F_WIDTH | F_FORM | F_D : kind === 'ink' ? F_WIDTH | F_LINES : kind === 'text' ? F_TEXT : F_PARAMS
    if (mask & ~allowed || (mask & F_FORM && mask & F_D)) throw new Error('fields that do not fit the kind of object')
    const next: DynSample = { t: F(), bounds: { x: F(), y: F(), width: F(), height: F() } }
    const width = mask & F_WIDTH ? F() : undefined
    if (kind === 'shape') {
      if (mask & F_FORM) {
        const form = S()
        const n = U()
        const numbers = run(n)
        let parts = forms.get(form)
        if (!parts) forms.set(form, (parts = form.split('#')))
        if (parts.length !== n + 1) throw new Error('a path form that does not fit its numbers')
        next.parts = parts
        next.numbers = numbers
      } else if (mask & F_D) {
        const d = S()
        next.d = d
        Object.assign(next, splitNumbers(d, forms))
      }
      if (width !== undefined) next.width = width
    } else if (kind === 'ink') {
      if (mask & F_LINES) {
        const ends = new Uint32Array(U())
        let total = 0
        for (let k = 0; k < ends.length; k++) ends[k] = total += U()
        next.lines = { xy: run(total * 2), ends }
      } else next.lines = NO_LINES
      if (width !== undefined) next.width = width
    } else if (kind === 'text') {
      if (mask & F_TEXT) next.html = sampleHtml(S(), math)
    } else if (mask & F_PARAMS) {
      const n = U()
      const names: string[] = []
      for (let k = 0; k < n; k++) names.push(S())
      const params: Record<string, number> = {}
      // defineProperty: a parameter named __proto__ is an own value, as JSON.parse makes it.
      for (const name of names) Object.defineProperty(params, name, { value: F(), writable: true, enumerable: true, configurable: true })
      next.params = params
    }
    keep(samples, next, seed)
  }
  if (u !== u32.length || f !== f64.length) throw new Error('a chunk with more data than its records')
  // An object of a kind that has no frames (html) has no entry.
  for (const [sid, t] of chunk.lastChange) {
    const entry = objects.get(sid)
    if (entry) entry.lastChange = t
  }
}
