/**
 * The frames of a scene: the samples of its changing objects (SceneSample),
 * as the stage's worker computes them in the sampling pass. They go from the
 * stage page to the board renderer over a direct MessagePort (main only hands
 * over the two ends: main/live-scene.ts), as chunks of typed arrays. Small
 * headers and control messages stay JSON.
 *
 * The worker encodes (FrameEncoder); the renderer decodes (renderer/live/frames.ts)
 * into the samples that playback uses. A chunk holds whole records; a record
 * holds samples of one object, by its stage id (sid), in sampling order; a
 * large object goes on in records of the next chunks (FLAG_MORE). The skeleton of the
 * description (the worker's reply) gives each object with samples their
 * number; the renderer checks it.
 *
 * Format version 1. A chunk is { t: 'frames', v, job, seq, u32, f64, strings }:
 *
 *   u32: record count, then per record: sid, kind (KIND_*), flags (1: math text; 2: more samples
 *        of the object of the record before, which is in an earlier chunk), sample count,
 *        then per sample: a field mask (F_*) and, for each field in it, its u32 parts.
 *   f64: per sample: t, bounds x, y, width, height, then the f64 parts of its fields, in mask order.
 *   strings: the chunk's string table (path forms, raw paths, texts, parameter names, JSON fallbacks).
 *
 * Fields (in mask order):
 *   F_WIDTH   f64 width
 *   F_FORM    u32 string (d with every number replaced by '#'), u32 n; f64 the n numbers
 *   F_D       u32 string (a shape's d as it is; the renderer splits it)
 *   F_LINES   u32 lines; per line u32 points; f64 x, y per point
 *   F_TEXT    u32 string
 *   F_PARAMS  u32 n; per parameter u32 name string; f64 the n values
 *   F_JSON    u32 string: the whole sample as JSON (no f64 part). For any sample whose values
 *             JSON would change (not finite, not plain), so that the result is exactly the same.
 *
 * Every f64 value is finite, and -0 is sent as 0 (JSON does the same).
 */

export const FRAMES_VERSION = 1

export const KIND_SHAPE = 0
export const KIND_INK = 1
export const KIND_TEXT = 2
export const KIND_LIVE = 3
export const FRAME_KINDS = ['shape', 'ink', 'text', 'live'] as const
export type FrameKind = (typeof FRAME_KINDS)[number]

export const F_WIDTH = 1
export const F_FORM = 2
export const F_D = 4
export const F_LINES = 8
export const F_TEXT = 16
export const F_PARAMS = 32
export const F_JSON = 64
export const F_ALL = 127

export const FLAG_MATH = 1
/** The record goes on with the object of the last record of the chunk before. */
export const FLAG_MORE = 2

/** A chunk is sent when it holds at least this many bytes: a chunk is at most this and one sample (large objects are split). */
export const CHUNK_BYTES = 1024 * 1024
/** The bytes on the way from the worker to the board at most (the worker waits for the board's acks). */
export const CREDIT_BYTES = 32 * 1024 * 1024
/** The frames of one scene at most. */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024

/** A chunk of frames (worker → page → renderer). */
export interface FramesChunk {
  t: 'frames'
  v: number
  job: number
  seq: number
  u32: Uint32Array
  f64: Float64Array
  strings: string[]
}

/** The bytes a chunk holds (its arrays and its strings, two bytes per character). */
export function chunkBytes(chunk: Pick<FramesChunk, 'u32' | 'f64' | 'strings'>): number {
  let bytes = chunk.u32.byteLength + chunk.f64.byteLength
  for (const text of chunk.strings) bytes += text.length * 2
  return bytes
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57

/**
 * A path d as its form (every number replaced by '#') and its numbers. The
 * renderer blends samples of one form. exact: joinPath(form.split('#'),
 * numbers) gives d again (each number is written as String(number) writes
 * it, and d has no '#' of its own).
 *
 * The numbers are the matches of /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, found
 * by a scan instead of the regular expression: in the stage's locked realm
 * (T14) V8 takes its slow path for RegExp replace, about three times slower.
 */
export function splitPath(d: string): { form: string; numbers: number[]; exact: boolean } {
  const numbers: number[] = []
  let exact = true
  let form = ''
  let last = 0
  const n = d.length
  let i = 0
  while (i < n) {
    const c = d.charCodeAt(i)
    const j = c === 45 ? i + 1 : i
    let k = j
    while (k < n && isDigit(d.charCodeAt(k))) k++
    let end = -1
    if (k > j) {
      if (k < n && d.charCodeAt(k) === 46) {
        k++
        while (k < n && isDigit(d.charCodeAt(k))) k++
      }
      end = k
    } else if (j + 1 < n && d.charCodeAt(j) === 46 && isDigit(d.charCodeAt(j + 1))) {
      k = j + 2
      while (k < n && isDigit(d.charCodeAt(k))) k++
      end = k
    }
    if (end < 0) {
      if (c === 35) exact = false
      i++
      continue
    }
    // An exponent (e or E, a sign, digits) belongs to the number only with its digits.
    if (end < n && (d.charCodeAt(end) | 32) === 101) {
      let m = end + 1
      if (m < n && (d.charCodeAt(m) === 43 || d.charCodeAt(m) === 45)) m++
      let q = m
      while (q < n && isDigit(d.charCodeAt(q))) q++
      if (q > m) end = q
    }
    const match = d.slice(i, end)
    const value = Number(match)
    numbers.push(value)
    if (exact && String(value) !== match) exact = false
    form += d.slice(last, i) + '#'
    last = end
    i = end
  }
  form += d.slice(last)
  return { form, numbers, exact }
}

/** d again from its form's parts (form.split('#')) and its numbers. */
export function joinPath(parts: readonly string[], numbers: ArrayLike<number>): string {
  let d = parts[0]
  for (let i = 0; i < numbers.length; i++) d += String(numbers[i]) + parts[i + 1]
  return d
}

/** A growable typed array. */
class Grow<T extends Uint32Array | Float64Array> {
  length = 0
  constructor(
    private array: T,
    private readonly make: (size: number) => T
  ) {}

  push(value: number): void {
    if (this.length === this.array.length) {
      const next = this.make(this.array.length * 2)
      next.set(this.array)
      this.array = next
    }
    this.array[this.length++] = value
  }

  /** The values so far, as an array of their own; the buffer starts empty again. */
  take(): T {
    const out = this.array.slice(0, this.length) as T
    this.length = 0
    return out
  }

  set(index: number, value: number): void {
    this.array[index] = value
  }

  /** Forget the values after `length` (a sample that falls back to JSON). */
  cut(length: number): void {
    this.length = length
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
/** Positive zero for -0 (JSON writes -0 as 0). */
const plus = (value: number): number => (value === 0 ? 0 : value)
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The worker's encoder. add() takes the samples of one object as the sampling
 * makes them, and calls onFull when the chunk is full (also in the middle of
 * an object: the object goes on in a record with FLAG_MORE). onFull sends the
 * chunk (take() gives its arrays and starts the next).
 */
export class FrameEncoder {
  constructor(private readonly onFull: () => void) {}

  private readonly u32 = new Grow(new Uint32Array(1 << 14), (n) => new Uint32Array(n))
  private readonly f64 = new Grow(new Float64Array(1 << 15), (n) => new Float64Array(n))
  private strings: string[] = []
  private stringIndex = new Map<string, number>()
  private stringBytes = 0
  private records = 0

  get empty(): boolean {
    return this.records === 0
  }

  get bytes(): number {
    return this.u32.length * 4 + this.f64.length * 8 + this.stringBytes
  }

  full(): boolean {
    return this.bytes >= CHUNK_BYTES
  }

  private text(value: string): number {
    let index = this.stringIndex.get(value)
    if (index === undefined) {
      index = this.strings.length
      this.strings.push(value)
      this.stringIndex.set(value, index)
      this.stringBytes += value.length * 2
    }
    return index
  }

  /** The samples of one object (kind: shape, ink, text or live; other kinds have none that play). */
  add(sid: number, kind: string, math: boolean, samples: readonly Record<string, unknown>[]): void {
    const code = FRAME_KINDS.indexOf(kind as FrameKind)
    if (code < 0) return
    let i = 0
    let more = false
    for (;;) {
      if (!this.records) this.u32.push(0)
      this.records++
      this.u32.push(sid)
      this.u32.push(code)
      this.u32.push((math ? FLAG_MATH : 0) | (more ? FLAG_MORE : 0))
      const countAt = this.u32.length
      this.u32.push(0)
      let n = 0
      while (i < samples.length) {
        this.sample(code, samples[i++])
        n++
        if (this.full()) break
      }
      this.u32.set(countAt, n)
      if (this.full()) this.onFull()
      if (i >= samples.length) return
      more = true
    }
  }

  private sample(kind: number, sample: Record<string, unknown>): void {
    const u0 = this.u32.length
    const f0 = this.f64.length
    if (!this.typed(kind, sample)) {
      this.u32.cut(u0)
      this.f64.cut(f0)
      this.u32.push(F_JSON)
      this.u32.push(this.text(JSON.stringify(sample)))
    }
  }

  /** The sample in typed form, with exactly the values the renderer reads (compile.ts prepareSample); false when only JSON keeps it exact. */
  private typed(kind: number, sample: Record<string, unknown>): boolean {
    if (!isPlain(sample) || typeof sample.toJSON === 'function') return false
    const { t, bounds } = sample
    if (!finite(t) || !isPlain(bounds) || typeof bounds.toJSON === 'function') return false
    const keys = Object.keys(bounds)
    if (keys.length !== 4 || keys[0] !== 'x' || keys[1] !== 'y' || keys[2] !== 'width' || keys[3] !== 'height') return false
    const { x, y, width, height } = bounds
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return false
    const maskAt = this.u32.length
    this.u32.push(0)
    this.f64.push(plus(t))
    this.f64.push(plus(x))
    this.f64.push(plus(y))
    this.f64.push(plus(width))
    this.f64.push(plus(height))
    let mask = 0
    const putWidth = (): boolean => {
      if (sample.width === undefined) return true
      if (!finite(sample.width)) return false
      mask |= F_WIDTH
      this.f64.push(plus(sample.width))
      return true
    }
    if (kind === KIND_SHAPE) {
      if (sample.d) {
        if (typeof sample.d !== 'string' || !putWidth()) return false
        const { form, numbers, exact } = splitPath(sample.d)
        if (exact) {
          mask |= F_FORM
          this.u32.push(this.text(form))
          this.u32.push(numbers.length)
          for (const n of numbers) this.f64.push(n)
        } else {
          mask |= F_D
          this.u32.push(this.text(sample.d))
        }
      }
    } else if (kind === KIND_INK) {
      if (!putWidth()) return false
      if (sample.lines) {
        if (!Array.isArray(sample.lines)) return false
        mask |= F_LINES
        this.u32.push(sample.lines.length)
        for (const line of sample.lines as unknown[]) {
          if (!Array.isArray(line)) return false
          this.u32.push(line.length)
          for (const p of line as unknown[]) {
            if (!Array.isArray(p) || p.length < 2 || !finite(p[0]) || !finite(p[1])) return false
            this.f64.push(plus(p[0]))
            this.f64.push(plus(p[1]))
          }
        }
      }
    } else if (kind === KIND_TEXT) {
      if (sample.text !== undefined) {
        if (typeof sample.text !== 'string') return false
        mask |= F_TEXT
        this.u32.push(this.text(sample.text))
      }
    } else if (kind === KIND_LIVE) {
      if (sample.params) {
        const params = sample.params
        if (!isPlain(params) || typeof params.toJSON === 'function') return false
        const names = Object.keys(params)
        const values: number[] = []
        for (const name of names) {
          const value = params[name]
          if (!finite(value)) return false
          values.push(value)
        }
        mask |= F_PARAMS
        this.u32.push(names.length)
        for (const name of names) this.u32.push(this.text(name))
        for (const value of values) this.f64.push(plus(value))
      }
    }
    this.u32.set(maskAt, mask)
    return true
  }

  /** The chunk's arrays and strings; the encoder starts the next chunk. */
  take(): { u32: Uint32Array; f64: Float64Array; strings: string[] } {
    if (this.records) this.u32.set(0, this.records)
    const out = { u32: this.u32.take(), f64: this.f64.take(), strings: this.strings }
    this.strings = []
    this.stringIndex = new Map()
    this.stringBytes = 0
    this.records = 0
    return out
  }
}
