import type { WorldPin } from '@shared/world-protocol'
import type { ItemClock, LiveTimeline, SceneView } from './clock'

/**
 * The host protocol of live items: one contract for shader, canvas and
 * program items (shader.ts, sandbox.ts, program.ts).
 *
 * - init(seed, assets): the constructor (HostStart: code, seed, size,
 *   params, the first tick, the clock or the timeline).
 * - advance(tick, inputs): live hosts follow the item clock (`follow`) and
 *   run one tick per display frame; step hosts run every tick up to
 *   `advance(to)` with the timeline's params and steps as inputs, then hold.
 *   A step host on the board then goes live (`goLive`): a seek or a replay
 *   of a canvas or program item steps from the scene's start (registry.ts).
 * - render(): canvas and program items draw inside their ticks; a held host
 *   draws its tick again for new params or a new size.
 * - capture(): the pixels and the exact tick they show. A capture never runs
 *   a frame: a held item gives the pixels it shows. `advance(to, true)`
 *   captures tick `to` in the same task as its drawing (the barrier: nothing
 *   runs between the tick and its picture), then the host holds.
 * - dispose(): ends the worker and frees its GPU contexts.
 *
 * The shader engine is a pure function of the tick and the params, so a
 * shader host draws the asked tick at once; canvas and program hosts keep
 * state from tick to tick and step through every tick.
 */

export interface CanvasSize {
  /** Board points. */
  w: number
  h: number
  /** Device pixels of the backing store. */
  pw: number
  ph: number
}

export type LiveInput = 'none' | 'enter' | 'direct'

/** A picture of an item and the tick it shows; url null when no picture could be taken. */
export interface LiveFrame {
  url: string | null
  tick: number
  /** Worlds: the published points in this picture, from the nominal rect's top-left. */
  points?: Record<string, [number, number, boolean]>
  /** Worlds: where the picture sits in board points, from the nominal rect's top-left. It can pass the rect. */
  box?: { x: number; y: number; w: number; h: number }
}

export interface HostStart {
  /** The item's node id. */
  id: string
  code: string
  seed: number
  /** Worlds: world.data. */
  data?: unknown
  /** Worlds: the marks kept on parts. */
  pins?: WorldPin[]
  size: CanvasSize
  params: Record<string, number>
  /** live: follow the item clock in real time (board items). step: run ticks only on advance (previews, stills, checks). */
  mode: 'live' | 'step'
  /** The first tick the host runs. */
  from: number
  /** Live hosts: the item clock and what the code sees of its scene. */
  clock: ItemClock
  scene: SceneView
  /** Step hosts: the params and steps over time; null keeps the params. */
  timeline: LiveTimeline | null
  /** Live hosts: on screen (runs ticks). */
  visible: boolean
}

export interface HostEvents {
  /** Alive: the frames drawn so far and the tick the host is at. */
  onAlive(frames: number, tick: number): void
  onError(message: string): void
  /** A GPU context of the code was lost: the item starts a fresh host. */
  onLost(): void
  /** The number of GPU contexts the code made. */
  onGpu(contexts: number): void
  /** A step host moved on. */
  onProgress?(tick: number): void
  /** Program items: the input mode the program asked for, its report() values, Escape in its frame. */
  onInput?(mode: LiveInput): void
  onReport?(values: unknown): void
  onEscape?(): void
}

export interface LiveHost {
  /** The element that shows the pixels on the page, or null (a step host). */
  readonly element: HTMLElement | null
  /** Live hosts: a new item clock (a pause, a seek, the end of the scene). */
  follow(clock: ItemClock, scene: SceneView): void
  /** A step host on the board, after `advance`: from its tick it follows `clock` live, with `params`. */
  goLive(clock: ItemClock, scene: SceneView, params: Record<string, number>): void
  /** Live hosts: on screen or not. Off screen the host runs nothing. */
  run(on: boolean): void
  setParams(params: Record<string, number>): void
  resize(size: CanvasSize): void
  /** Step hosts: run every tick up to `to`, then hold; capture: the picture of tick `to`. Null when the host failed. */
  advance(to: number, capture: boolean): Promise<LiveFrame | null>
  /** The picture of the tick the host shows now; it runs no frame. Null when it does not answer. */
  capture(): Promise<LiveFrame | null>
  /** Program items: the learner's input goes to the item. */
  setEntered(on: boolean): void
  /** End the worker and free its GPU contexts; the element keeps its last picture. */
  stop(): void
  /** Stop, and take the element off the page. */
  dispose(): void
}

export function blobUrl(blob: unknown): Promise<string | null> {
  if (!(blob instanceof Blob)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/**
 * The page half of the worker protocol (runtime.ts), for canvas and program
 * hosts: it sends advance and capture requests and matches their answers.
 */
export class WorkerLink {
  private waits = new Map<number, (frame: LiveFrame | null) => void>()
  private nextId = 1
  private closed = false

  constructor(
    private send: (message: Record<string, unknown>) => void,
    private events: HostEvents,
    private mapError: (message: string) => string
  ) {}

  /** A message from the worker. True when it was one of the protocol's. */
  receive(data: unknown): boolean {
    if (!data || typeof data !== 'object' || this.closed) return false
    const m = data as { type?: unknown; frames?: unknown; tick?: unknown; id?: unknown; blob?: unknown; message?: unknown; contexts?: unknown }
    const tick = typeof m.tick === 'number' ? m.tick : -1
    switch (m.type) {
      case 'alive':
        if (typeof m.frames === 'number') this.events.onAlive(m.frames, tick)
        return true
      case 'progress':
        this.events.onProgress?.(tick)
        return true
      case 'at':
        if (typeof m.id === 'number') this.settle(m.id, { url: null, tick })
        return true
      case 'frame': {
        if (typeof m.id !== 'number') return true
        const id = m.id
        void blobUrl(m.blob).then((url) => this.settle(id, { url, tick }))
        return true
      }
      case 'gpu':
        if (typeof m.contexts === 'number') this.events.onGpu(m.contexts)
        return true
      case 'lost':
        this.events.onLost()
        return true
      case 'error':
        if (typeof m.message === 'string') this.events.onError(this.mapError(m.message))
        this.close()
        return true
      default:
        return false
    }
  }

  private settle(id: number, frame: LiveFrame | null): void {
    const resolve = this.waits.get(id)
    if (!resolve) return
    this.waits.delete(id)
    resolve(frame)
  }

  /** Send a request with a fresh id; resolves with its answer, or null after `ms` (no limit when omitted) or when the link closes. */
  request(message: Record<string, unknown>, ms?: number): Promise<LiveFrame | null> {
    if (this.closed) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = ms === undefined ? 0 : window.setTimeout(() => this.settle(id, null), ms)
      this.waits.set(id, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.send({ ...message, id })
    })
  }

  close(): void {
    this.closed = true
    for (const resolve of this.waits.values()) resolve(null)
    this.waits.clear()
  }
}
