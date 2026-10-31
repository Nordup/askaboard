import type { WorldKey, WorldPin, WorldPointer, WorldToPage } from '@shared/world-protocol'
import type { ItemClock, LiveTimeline, SceneView } from '../clock'
import { boardSurface, WorldSurface, type WorldMember } from './surface'

/**
 * A world's host: a thin object that forwards to the surface (surface.ts).
 * Each host is one generation of its world, so a seek makes a new generation
 * (registry.ts): it ticks unseen and catches up while the old one stays on the
 * surface with its last picture, then the page shows the new one and removes
 * the old one in one paint. A generation shows when it goes live, or at its
 * first frame when it starts live.
 *
 * A step host has a private surface (previews, stills, checks): it runs ticks
 * only on advance, every tick up to `to` with the timeline's params and steps
 * as inputs, then holds. A capture never runs a frame: a held world gives the
 * pixels it shows, and `advance(to, true)` captures tick `to` in the same task
 * as its drawing. A still shows all that the world reaches, so it can pass the
 * nominal rect: its box says where.
 */

export type LiveInput = 'none' | 'enter' | 'direct'

/** A picture of a world and the tick it shows; url null when no picture could be taken. */
export interface LiveFrame {
  url: string | null
  tick: number
  /** The published points in this picture, from the nominal rect's top-left. */
  points?: Record<string, [number, number, boolean]>
  /** Where the picture sits in board points, from the nominal rect's top-left. It can pass the rect. */
  box?: { x: number; y: number; w: number; h: number }
}

export interface HostStart {
  /** The world's node id. */
  id: string
  code: string
  seed: number
  data?: unknown
  pins?: WorldPin[]
  /** The nominal size in board points. */
  w: number
  h: number
  /** Step hosts: pixels per board point of a still. */
  dpr?: number
  params: Record<string, number>
  /** live: follow the item clock in real time (board worlds). step: run ticks only on advance. */
  mode: 'live' | 'step'
  /** The first tick the host runs. */
  from: number
  clock: ItemClock
  scene: SceneView
  /** Step hosts: the params and steps over time; null keeps the params. */
  timeline: LiveTimeline | null
  /** It runs ticks. */
  visible: boolean
}

export interface HostEvents {
  /** Alive: the frames drawn so far and the tick the host is at. */
  onAlive(frames: number, tick: number): void
  onError(message: string): void
  /** The worker ended: the world starts a new generation. */
  onLost(): void
  /** A stepping host moved on. */
  onProgress?(tick: number): void
  onInput?(mode: LiveInput): void
  onReport?(values: unknown): void
}

function blobUrl(blob: unknown): Promise<string | null> {
  if (!(blob instanceof Blob)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/** The board colour tokens for a world's code, as CSS colour strings in `colors`, read once from content.css. */
let colorCache: Record<string, string> | null = null
function boardColors(): Record<string, string> {
  if (colorCache) return colorCache
  const probe = document.createElement('div')
  probe.className = 'board__content'
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const read = (name: string): string => style.getPropertyValue(name).trim()
  colorCache = {
    text: read('--ls-text'),
    muted: read('--ls-muted'),
    accent: read('--ls-accent'),
    good: read('--ls-good'),
    bad: read('--ls-bad'),
    warn: read('--ls-warn'),
    card: read('--ls-card'),
    card2: read('--ls-card-2'),
    border: read('--ls-border'),
    bg: read('--bg-canvas')
  }
  probe.remove()
  return colorCache
}

let nextGeneration = 1

export type WorldHit = NonNullable<Extract<WorldToPage, { type: 'picked' }>['hit']>

export class WorldHost implements WorldMember {
  readonly key: WorldKey
  shown = false
  /** What the world's code listens to now. */
  wants = { pointer: false, ink: false }
  /** Its code has run no frame yet: a long setup is no hang. */
  settingUp = true
  /** The names of its published points, from the last picture. */
  parts: string[] = []
  private readonly surface: WorldSurface
  private readonly step: boolean
  /** It shows at its first frame; a stepping generation shows when it goes live. */
  private readonly startsLive: boolean
  private waits = new Map<number, (frame: LiveFrame | null) => void>()
  private nextRequest = 1
  private picks = new Map<number, (hit: WorldHit | null) => void>()
  /** The strokes the world has, by id: each node and its board offset as they were sent. */
  private strokes = new Map<string, { node: unknown; at: readonly [number, number] }>()
  private pins: WorldPin[]
  private stopped = false

  constructor(
    start: HostStart,
    private events: HostEvents,
    container: HTMLElement | null
  ) {
    this.key = { node: start.id, generation: nextGeneration++ }
    this.pins = start.pins ?? []
    this.step = !container
    this.startsLive = start.mode === 'live'
    this.surface = container ? boardSurface(container) : new WorldSurface(null, null, { width: start.w, height: start.h, dpr: start.dpr ?? 1 })
    this.surface.add(
      this,
      {
        ...this.key,
        code: start.code,
        seed: start.seed,
        ...(start.data === undefined ? {} : { data: start.data }),
        ...(this.pins.length ? { pins: this.pins } : {}),
        w: start.w,
        h: start.h,
        params: start.params,
        mode: start.mode,
        from: start.from,
        clock: start.clock,
        scene: start.scene,
        timeline: start.timeline,
        colors: boardColors()
      },
      start.visible
    )
  }

  /** A message of this generation from the worker. */
  receive(m: Extract<WorldToPage, { key: WorldKey }>): void {
    switch (m.type) {
      case 'alive':
        if (m.frames > 0) this.settingUp = false
        if (m.frames > 0 && !this.shown && this.startsLive && !this.stopped) this.show()
        this.events.onAlive(m.frames, m.tick)
        break
      case 'progress':
        this.settingUp = false
        this.events.onProgress?.(m.tick)
        break
      case 'picked':
        this.picks.get(m.request)?.(m.hit)
        this.picks.delete(m.request)
        break
      case 'subscribe':
        this.wants = { pointer: m.pointer, ink: m.ink }
        if (!m.ink) this.strokes.clear()
        this.surface.wantsChanged()
        break
      case 'anchor':
        this.surface.anchor(this.key.node, m.dx, m.dy)
        break
      case 'cursor':
        this.surface.cursor(m.value)
        break
      case 'at':
        this.settle(m.request, { url: null, tick: m.tick })
        break
      case 'frame': {
        const { request, tick } = m
        const { blob, x, y, w, h, points } = m.still
        void blobUrl(blob).then((url) => this.settle(request, { url, tick, box: { x, y, w, h }, ...(points ? { points } : {}) }))
        break
      }
      case 'error':
        this.failed(m.message)
        break
      case 'input':
        this.events.onInput?.(m.mode)
        break
      case 'report':
        this.events.onReport?.(m.values)
        break
    }
  }

  private show(): void {
    this.shown = true
    this.surface.anchor(this.key.node, 0, 0)
    this.surface.changed()
  }

  settled(): void {
    if (this.shown || !this.startsLive || this.stopped) return
    this.show()
    this.events.onAlive(1, 0)
  }

  /** The points of the picture on the surface. */
  showPoints(points: Record<string, [number, number, boolean]> | undefined): void {
    if (points) this.parts = Object.keys(points).filter((name) => !name.startsWith('pin:'))
  }

  /** What is at a board point: null for nothing, or after `ms`. */
  pick(x: number, y: number, ms: number): Promise<WorldHit | null> {
    if (this.stopped) return Promise.resolve(null)
    const request = this.nextRequest++
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.picks.delete(request)
        resolve(null)
      }, ms)
      this.picks.set(request, (hit) => {
        clearTimeout(timer)
        resolve(hit)
      })
      this.surface.send({ type: 'pick', key: this.key, x, y, request })
    })
  }

  pointer(event: WorldPointer): void {
    if (!this.stopped) this.surface.send({ type: 'pointer', key: this.key, event })
  }

  /** The board's ink now: new and changed strokes go to the world, and it hears which are gone. */
  sendInk(inks: ReadonlyArray<{ id: string; node: unknown; at: readonly [number, number]; points: () => Array<[number, number, number]> }>): void {
    const present = new Set<string>()
    for (const ink of inks) {
      present.add(ink.id)
      const sent = this.strokes.get(ink.id)
      if (sent && sent.node === ink.node && sent.at[0] === ink.at[0] && sent.at[1] === ink.at[1]) continue
      this.strokes.set(ink.id, { node: ink.node, at: ink.at })
      this.surface.send({ type: 'ink', key: this.key, stroke: { id: ink.id, points: ink.points() } })
    }
    for (const id of [...this.strokes.keys()]) {
      if (present.has(id)) continue
      this.strokes.delete(id)
      this.surface.send({ type: 'inkgone', key: this.key, id })
    }
  }

  /** The marks kept on parts changed. */
  setPins(pins: WorldPin[]): void {
    for (const pin of pins) if (!this.pins.some((entry) => entry.id === pin.id)) this.surface.send({ type: 'pin', key: this.key, pin })
    for (const pin of this.pins) if (!pins.some((entry) => entry.id === pin.id)) this.surface.send({ type: 'unpin', key: this.key, id: pin.id })
    this.pins = pins
  }

  /** It takes no part in a new worker: it failed or left. */
  get ended(): boolean {
    return this.stopped
  }

  failed(message: string): void {
    this.shown = false
    this.surface.changed()
    this.stop()
    this.closeWaits()
    this.events.onError(message)
  }

  /** Its worker ended: the item starts a new generation. */
  lost(): void {
    this.stopped = true
    this.closeWaits()
    this.events.onLost()
  }

  private settle(request: number, frame: LiveFrame | null): void {
    const resolve = this.waits.get(request)
    if (!resolve) return
    this.waits.delete(request)
    resolve(frame)
  }

  private closeWaits(): void {
    for (const resolve of this.waits.values()) resolve(null)
    this.waits.clear()
    for (const resolve of this.picks.values()) resolve(null)
    this.picks.clear()
  }

  private request(message: (request: number) => Parameters<WorldSurface['send']>[0], ms?: number): Promise<LiveFrame | null> {
    if (this.stopped) return Promise.resolve(null)
    const request = this.nextRequest++
    return new Promise((resolve) => {
      const timer = ms === undefined ? 0 : window.setTimeout(() => this.settle(request, null), ms)
      this.waits.set(request, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.surface.send(message(request))
    })
  }

  follow(clock: ItemClock, scene: SceneView): void {
    this.surface.send({ type: 'clock', key: this.key, clock, scene })
  }

  goLive(clock: ItemClock, scene: SceneView, params: Record<string, number>): void {
    this.surface.send({ type: 'live', key: this.key, clock, scene, params })
    this.show()
  }

  run(on: boolean): void {
    if (!this.stopped) this.surface.send({ type: 'run', key: this.key, on })
  }

  setParams(params: Record<string, number>): void {
    this.surface.send({ type: 'params', key: this.key, params })
  }

  resize(w: number, h: number): void {
    this.surface.send({ type: 'size', key: this.key, w, h })
  }

  advance(to: number, capture: boolean): Promise<LiveFrame | null> {
    return this.request((request) => ({ type: 'advance', key: this.key, to, capture, request }))
  }

  capture(): Promise<LiveFrame | null> {
    return this.request((request) => ({ type: 'capture', key: this.key, request }), 1500)
  }

  /** The learner's input goes to the world, or leaves it. */
  setEntered(on: boolean): void {
    if (this.wants.pointer) this.pointer({ kind: on ? 'enter' : 'leave', x: 0, y: 0, buttons: 0, pressure: 0, pointerType: 'mouse' })
  }

  /** It runs no more ticks. Its last picture stays on the surface until `dispose`. */
  stop(): void {
    if (this.stopped) return
    this.surface.send({ type: 'run', key: this.key, on: false })
    this.stopped = true
  }

  dispose(): void {
    this.stopped = true
    this.closeWaits()
    this.surface.cursor('')
    this.surface.remove(this.key)
    if (this.step) this.surface.dispose()
  }
}
