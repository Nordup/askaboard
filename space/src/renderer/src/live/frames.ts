import { chunkBytes, F_ALL, F_D, F_FORM, F_JSON, F_LINES, F_PARAMS, F_TEXT, F_WIDTH, FLAG_MATH, FLAG_MORE, FRAME_KINDS, FRAMES_VERSION, joinPath, type FrameKind, type FramesChunk } from '@shared/frames'
import type { SceneSample } from '@shared/live-scene'
import { svgPathPolylines } from '../agent/ink'
import type { Point } from '../board/types'
import { prepareSample, sampleHtml, splitNumbers, type DynSample } from './compile'

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
 * The frames of one job at most wait here: the stage runs one program at a
 * time, so a chunk of a newer job drops older ones. A chunk out of order, of
 * another version or with a wrong value spoils its job, and the job's
 * takeFrames fails.
 */

/** The samples of one object, by its stage id. */
export interface ObjectFrames {
  kind: FrameKind
  math: boolean
  samples: DynSample[]
  /** The object's path forms (one parts array per form, across chunks). */
  forms: Map<string, readonly string[]>
}

interface JobFrames {
  /** The next chunk expected. */
  next: number
  /** The object of the last record (a record with FLAG_MORE goes on with it). */
  last: number | null
  objects: Map<number, ObjectFrames>
  bytes: number
  /** ms spent decoding, and the longest chunk. */
  ms: number
  longest: number
  error: string | null
}

/** The frames of a run, ready for its compile: by stage object id, and their size. */
export interface RunFrames {
  objects: Map<number, ObjectFrames>
  bytes: number
}

let port: MessagePort | null = null
const jobs = new Map<number, JobFrames>()

function onWindowMessage(event: MessageEvent): void {
  if (event.data !== 'ls-frames-port' || event.ports.length !== 1) return
  port?.close()
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
    jobs.delete(m.job)
    return
  }
  if (m.t !== 'frames' || typeof m.job !== 'number' || typeof m.seq !== 'number') return
  const job = m.job
  let frames = jobs.get(job)
  if (!frames) {
    for (const id of [...jobs.keys()]) if (id < job) jobs.delete(id)
    frames = { next: 0, last: null, objects: new Map(), bytes: 0, ms: 0, longest: 0, error: null }
    jobs.set(job, frames)
  }
  if (frames.error === null) {
    try {
      if (m.v !== FRAMES_VERSION) throw new Error(`frames of version ${String(m.v)} (this board reads ${FRAMES_VERSION})`)
      if (m.seq !== frames.next) throw new Error(`chunk ${m.seq} came where chunk ${frames.next} was due`)
      if (!(m.u32 instanceof Uint32Array) || !(m.f64 instanceof Float64Array) || !Array.isArray(m.strings) || !m.strings.every((text) => typeof text === 'string')) throw new Error('a chunk of the wrong shape')
      const chunk = m as unknown as FramesChunk
      const t0 = performance.now()
      frames.last = decode(chunk, frames.objects, frames.last)
      const ms = performance.now() - t0
      frames.ms += ms
      frames.longest = Math.max(frames.longest, ms)
      frames.bytes += chunkBytes(chunk)
      frames.next++
    } catch (error) {
      frames.error = error instanceof Error ? error.message : String(error)
      frames.objects.clear()
    }
  }
  port?.postMessage({ t: 'ack', job, seq: m.seq })
}

/**
 * The frames of run `job`, which sent `chunks` chunks; they leave this store.
 * Throws when they are not all here, or one could not be read.
 */
export function takeFrames(job: unknown, chunks: unknown): RunFrames {
  if (typeof job !== 'number' || typeof chunks !== 'number') throw new Error('The scene came without its frames.')
  const frames = jobs.get(job)
  jobs.delete(job)
  if (chunks === 0 && !frames) return { objects: new Map(), bytes: 0 }
  if (!frames) throw new Error('The board does not have the frames of the scene (the board window loaded again?). Write the scene again.')
  if (frames.error) throw new Error(`The frames of the scene could not be read: ${frames.error}`)
  if (frames.next !== chunks) throw new Error(`The board has ${frames.next} of the ${chunks} frame chunks of the scene.`)
  console.log(`frames: job ${job}: ${chunks} chunks, ${(frames.bytes / 1024 / 1024).toFixed(2)} MB, decoded in ${Math.round(frames.ms)} ms (longest chunk ${Math.round(frames.longest)} ms)`)
  return { objects: frames.objects, bytes: frames.bytes }
}

/**
 * Decode one chunk. A record starts the samples of its object again (the
 * sampling's last pass of an object wins), or with FLAG_MORE goes on with the
 * object of the record before it (`last`). Returns the object of its last record.
 */
function decode(chunk: FramesChunk, objects: Map<number, ObjectFrames>, last: number | null): number | null {
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
    const count = U()
    let entry: ObjectFrames
    if (flags & FLAG_MORE) {
      const before = last === sid ? objects.get(sid) : undefined
      if (!before || before.kind !== kind || before.math !== math) throw new Error('a record that goes on with another object')
      entry = before
    } else {
      entry = { kind, math, samples: [], forms: new Map() }
      objects.set(sid, entry)
    }
    last = sid
    const { forms, samples } = entry
    for (let i = 0; i < count; i++) {
      const mask = U()
      if (mask & ~F_ALL) throw new Error('an unknown field')
      if (mask & F_JSON) {
        if (mask !== F_JSON) throw new Error('a JSON sample with other fields')
        samples.push(prepareSample(kind, math, JSON.parse(S()) as SceneSample, forms))
        continue
      }
      const allowed = kind === 'shape' ? F_WIDTH | F_FORM | F_D : kind === 'ink' ? F_WIDTH | F_LINES | F_D : kind === 'text' ? F_TEXT : F_PARAMS
      if (mask & ~allowed || (mask & F_FORM && mask & F_D) || (mask & F_LINES && mask & F_D)) throw new Error('fields that do not fit the kind of object')
      const next: DynSample = { t: F(), bounds: { x: F(), y: F(), width: F(), height: F() } }
      const width = mask & F_WIDTH ? F() : undefined
      if (kind === 'shape') {
        if (mask & F_FORM) {
          const form = S()
          const n = U()
          const numbers: number[] = []
          for (let k = 0; k < n; k++) numbers.push(F())
          let parts = forms.get(form)
          if (!parts) forms.set(form, (parts = form.split('#')))
          if (parts.length !== n + 1) throw new Error('a path form that does not fit its numbers')
          next.d = joinPath(parts, numbers)
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
          const lines: Point[][] = []
          const n = U()
          for (let k = 0; k < n; k++) {
            const points = U()
            const line: Point[] = []
            for (let j = 0; j < points; j++) line.push([F(), F()])
            lines.push(line)
          }
          next.lines = lines
        } else if (mask & F_D) {
          const d = S()
          try {
            next.lines = svgPathPolylines(d)
          } catch {
            next.lines = []
          }
        } else next.lines = []
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
      samples.push(next)
    }
  }
  if (u !== u32.length || f !== f64.length) throw new Error('a chunk with more data than its records')
  return last
}
