import type { LiveNode } from '@shared/board-format'
import { absNow, seedOf, tickOf, type ItemClock, type LiveTimeline, type SceneView } from './clock'
import type { CanvasSize, HostEvents, HostStart, LiveFrame, LiveHost } from './host'
import { CanvasHost } from './sandbox'
import { ProgramHost } from './program'
import { ShaderHost } from './shader'
import { WorldHost } from './world/host'
import { withStepSlot } from './slots'

/**
 * Stills of live items at moments of a scene, made by step hosts on this
 * page (the main window), apart from the snapshot window: its capture queue
 * gets finished pictures with their ticks, so a plain screenshot never
 * waits behind a simulation.
 *
 * One host per item per preview: it steps forward from the scene's start
 * through the asked moments in time order and takes one picture per tick
 * (advance with capture: the barrier), then it ends. Pictures go back in the
 * order of the request. A host that makes no progress for PROGRESS_MS gives
 * up (no picture). Step hosts take turns (slots.ts).
 */

const PROGRESS_MS = 8000
/** A program check ends after this long (pass). */
const CHECK_MS = 3000
/** The largest still: pixels per picture (a step host computes every tick at this size). */
const MAX_PIXELS = 2_000_000

export function createHost(mode: LiveNode['mode'], start: HostStart, events: HostEvents, container: HTMLElement | null): LiveHost {
  if (mode === 'shader') return new ShaderHost(start, events, container)
  if (mode === 'program') return new ProgramHost(start, events, container)
  if (mode === 'world') return new WorldHost(start, events, container)
  return new CanvasHost(start, events, container)
}

/** A still's size at `scale` px per board point, within MAX_PIXELS and 4096 px a side. */
export function stillSize(node: { w: number; h: number }, scale: number): CanvasSize {
  let pw = Math.max(1, Math.round(node.w * scale))
  let ph = Math.max(1, Math.round(node.h * scale))
  if (pw * ph > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (pw * ph))
    pw = Math.max(1, Math.round(pw * k))
    ph = Math.max(1, Math.round(ph * k))
  }
  return { w: Math.max(1e-3, node.w), h: Math.max(1e-3, node.h), pw: Math.min(pw, 4096), ph: Math.min(ph, 4096) }
}

const HELD: ItemClock = { t: 0, at: 0, rate: 0 }
const NO_SCENE: SceneView = { t: 0, playing: false, active: false, ended: true, step: null }

/**
 * A step host and a watchdog: `run` gets the host and `watch`, which ends a
 * piece of work with null when the host fails, when its tick does not move
 * for PROGRESS_MS (a setup that never ends, a hung loop), or after `limitMs`.
 */
async function withStepHost<T>(
  node: Pick<LiveNode, 'mode' | 'code' | 'name' | 'params'> & Partial<Pick<LiveNode, 'id' | 'data' | 'pins'>>,
  size: CanvasSize,
  from: number,
  timeline: LiveTimeline | null,
  run: (host: LiveHost, watch: <R>(work: Promise<R | null>) => Promise<R | null>) => Promise<T>,
  options: { onError?: (message: string) => void; limitMs?: number } = {}
): Promise<T> {
  return withStepSlot(async () => {
    const started = absNow()
    let moved = started
    let lastTick = -2
    let failed = false
    const progress = (tick: number): void => {
      if (tick === lastTick) return
      lastTick = tick
      moved = absNow()
    }
    const host = createHost(
      node.mode,
      { id: node.id ?? 'step', code: node.code, data: node.data, pins: node.pins, seed: seedOf(node), size, params: node.params, mode: 'step', from, clock: HELD, scene: NO_SCENE, timeline, visible: false },
      {
        onAlive: (_frames, tick) => progress(tick),
        onProgress: progress,
        onError: (message) => {
          failed = true
          options.onError?.(message)
        },
        onLost: () => undefined,
        onGpu: () => undefined
      },
      null
    )
    const watch = <R,>(work: Promise<R | null>): Promise<R | null> =>
      new Promise((resolve) => {
        const timer = window.setInterval(() => {
          const now = absNow()
          if (failed || now - moved > PROGRESS_MS || (options.limitMs !== undefined && now - started > options.limitMs)) {
            clearInterval(timer)
            resolve(null)
          }
        }, 100)
        void work.then((value) => {
          clearInterval(timer)
          resolve(value)
        })
      })
    try {
      return await run(host, watch)
    } finally {
      host.dispose()
    }
  })
}

export interface LiveStillRequest {
  node: LiveNode
  timeline: LiveTimeline | null
  /** The moments (scene time, s) and the frame each picture is for. */
  moments: Array<{ frame: number; t: number }>
}

export interface LiveStill {
  frame: number
  id: string
  url: string | null
  /** The tick the picture shows; null when there is none. */
  tick: number | null
  /** Worlds: the published points in this picture, from the nominal rect's top-left. */
  points?: Record<string, [number, number, boolean]>
  /** Worlds: where the picture sits, from the nominal rect's top-left. */
  box?: { x: number; y: number; w: number; h: number }
}

/** Pictures of each item at its moments: one step host per item, from tick 0 forward. */
export async function sceneStills(items: LiveStillRequest[], scale: number): Promise<LiveStill[]> {
  const results = await Promise.all(items.map((item) => itemStills(item, scale)))
  return results.flat()
}

async function itemStills(item: LiveStillRequest, scale: number): Promise<LiveStill[]> {
  const ticks = [...new Set(item.moments.map((moment) => tickOf(moment.t)))].sort((a, b) => a - b)
  const pictures = new Map<number, LiveFrame>()
  await withStepHost(item.node, stillSize(item.node, scale), 0, item.timeline, async (host, watch) => {
    for (const tick of ticks) {
      const frame = await watch(host.advance(tick, true))
      if (!frame) return
      pictures.set(tick, frame)
    }
  })
  return item.moments.map((moment) => {
    const frame = pictures.get(tickOf(moment.t))
    return { frame: moment.frame, id: item.node.id, url: frame?.url ?? null, tick: frame ? frame.tick : null, ...(frame?.points ? { points: frame.points } : {}), ...(frame?.box ? { box: frame.box } : {}) }
  })
}

/** A picture of an item that has no host on the board (not started, released): a fresh host at the tick of item time t. */
export async function stillAt(node: LiveNode, params: Record<string, number>, t: number, scale: number): Promise<LiveFrame | null> {
  const tick = tickOf(t)
  return withStepHost({ ...node, params }, stillSize(node, scale), tick, null, (host, watch) => watch(host.advance(tick, true)))
}

/**
 * Check a program or a world before a scene plays it: run its setup and its first
 * ticks in a step host, and return its first error (syntax, a failed
 * import, a runtime error), or null. A program still busy after CHECK_MS
 * (a slow import, a setup that waits) passes.
 */
export async function programError(mode: 'program' | 'world', code: string, params: Record<string, number>, size: [number, number] = [320, 200], data?: unknown): Promise<string | null> {
  let error: string | null = null
  await withStepHost(
    { mode, code, params, data },
    stillSize({ w: size[0], h: size[1] }, 1),
    0,
    null,
    (host, watch) => watch(host.advance(2, false)),
    {
      limitMs: CHECK_MS,
      onError: (message) => {
        error ??= message
      }
    }
  )
  return error
}
