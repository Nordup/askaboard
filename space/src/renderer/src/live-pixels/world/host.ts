import type { WorldKey, WorldStill, WorldToPage } from '@shared/world-protocol'
import type { ItemClock, SceneView } from '../clock'
import { blobUrl, type CanvasSize, type HostEvents, type HostStart, type LiveFrame, type LiveHost } from '../host'
import { boardColors } from '../sandbox'
import { boardSurface, WorldSurface, type WorldMember } from './surface'

/**
 * A world on the host protocol (host.ts): a thin host that forwards to the
 * surface (surface.ts). Each host is one generation of its world, so a seek
 * in the registry's restart works as it does for a program: the new generation
 * ticks unseen and catches up while the old one stays on the surface with its
 * last picture, then the page shows the new one and removes the old one in one
 * paint. A generation shows when it goes live, or at its first frame when it
 * starts live.
 *
 * A step host has a private surface (previews, stills, checks). A still can
 * reach past the nominal rect; in this slice the picture is cropped to it.
 */

let nextGeneration = 1

/** The still as a picture of the nominal rect, as a data URL. */
async function stillUrl(still: WorldStill, w: number, h: number): Promise<string | null> {
  if (!still.blob) return null
  if (still.x === 0 && still.y === 0 && still.w === w && still.h === h) return blobUrl(still.blob)
  const bitmap = await createImageBitmap(still.blob)
  const scale = bitmap.width / Math.max(1e-3, still.w)
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
  canvas.getContext('2d')?.drawImage(bitmap, still.x * scale, still.y * scale)
  bitmap.close()
  return blobUrl(await canvas.convertToBlob({ type: 'image/png' }))
}

export class WorldHost implements LiveHost, WorldMember {
  readonly element = null
  readonly key: WorldKey
  shown = false
  private readonly surface: WorldSurface
  private readonly step: boolean
  /** It shows at its first frame; a stepping generation shows when it goes live. */
  private readonly startsLive: boolean
  private w: number
  private h: number
  private waits = new Map<number, (frame: LiveFrame | null) => void>()
  private nextRequest = 1
  private stopped = false

  constructor(
    start: HostStart,
    private events: HostEvents,
    container: HTMLElement | null
  ) {
    this.key = { node: start.id, generation: nextGeneration++ }
    this.w = start.size.w
    this.h = start.size.h
    this.step = !container
    this.startsLive = start.mode === 'live'
    this.surface = container ? boardSurface(container) : new WorldSurface(null, null, { width: start.size.w, height: start.size.h, dpr: start.size.pw / start.size.w })
    this.surface.add(
      this,
      {
        ...this.key,
        code: start.code,
        seed: start.seed,
        w: start.size.w,
        h: start.size.h,
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
        if (m.frames > 0 && !this.shown && this.startsLive && !this.stopped) this.show()
        this.events.onAlive(m.frames, m.tick)
        break
      case 'progress':
        this.events.onProgress?.(m.tick)
        break
      case 'at':
        this.settle(m.request, { url: null, tick: m.tick })
        break
      case 'frame': {
        const { request, tick } = m
        void stillUrl(m.still, this.w, this.h).then((url) => this.settle(request, { url, tick }))
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
    this.surface.changed()
  }

  failed(message: string): void {
    this.shown = false
    this.surface.changed()
    this.stop()
    this.closeWaits()
    this.events.onError(message)
  }

  lost(): void {
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

  resize(size: CanvasSize): void {
    if (size.w === this.w && size.h === this.h) return
    this.w = size.w
    this.h = size.h
    this.surface.send({ type: 'size', key: this.key, w: size.w, h: size.h })
  }

  advance(to: number, capture: boolean): Promise<LiveFrame | null> {
    return this.request((request) => ({ type: 'advance', key: this.key, to, capture, request }))
  }

  capture(): Promise<LiveFrame | null> {
    return this.request((request) => ({ type: 'capture', key: this.key, request }), 1500)
  }

  /** Worlds take no pointer input in this slice. */
  setEntered(): void {}

  /** It runs no more ticks. Its last picture stays on the surface until `dispose`. */
  stop(): void {
    if (this.stopped) return
    this.surface.send({ type: 'run', key: this.key, on: false })
    this.stopped = true
  }

  dispose(): void {
    this.stopped = true
    this.closeWaits()
    this.surface.remove(this.key)
    if (this.step) this.surface.dispose()
  }
}
