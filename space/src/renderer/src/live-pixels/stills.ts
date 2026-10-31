import type { LiveNode } from '@shared/board-format'
import { absNow, seedOf, tickOf, type ItemClock, type LiveTimeline, type SceneView } from './clock'
import { WorldHost, type LiveFrame } from './world/host'

/**
 * Stills of worlds at moments of a scene, made by step hosts on this page
 * (the main window), apart from the snapshot window: its capture queue gets
 * finished pictures with their ticks, so a plain screenshot never waits behind
 * a simulation.
 *
 * One host per world per preview: it steps forward from the scene's start
 * through the asked moments in time order and takes one picture per tick
 * (advance with capture: the barrier), then it ends. Pictures go back in the
 * order of the request. A host that makes no progress for PROGRESS_MS gives
 * up (no picture). Step hosts take turns.
 */

const PROGRESS_MS = 8000
/** A check ends after this long (pass). */
const CHECK_MS = 3000
/** The largest still: pixels per picture (a step host computes every tick at this size). */
const MAX_PIXELS = 2_000_000
/** Step hosts that run at once. */
const STEP_HOSTS = 2

let stepRunning = 0
const stepQueue: Array<() => void> = []

/** Run `work` with a step host's turn: at most STEP_HOSTS at once, in the order asked. */
async function withStepTurn<T>(work: () => Promise<T>): Promise<T> {
  if (stepRunning >= STEP_HOSTS) await new Promise<void>((resolve) => stepQueue.push(resolve))
  else stepRunning++
  try {
    return await work()
  } finally {
    const next = stepQueue.shift()
    if (next) next()
    else stepRunning--
  }
}

/** Pixels per board point of a still at `scale`, within MAX_PIXELS and 4096 px a side. */
export function stillScale(node: { w: number; h: number }, scale: number): number {
  const w = Math.max(1e-3, node.w)
  const h = Math.max(1e-3, node.h)
  return Math.min(scale, Math.sqrt(MAX_PIXELS / (w * h)), 4096 / w, 4096 / h)
}

const HELD: ItemClock = { t: 0, at: 0, rate: 0 }
const NO_SCENE: SceneView = { t: 0, playing: false, active: false, ended: true, step: null }

/**
 * A step host and a watchdog: `run` gets the host and `watch`, which ends a
 * piece of work with null when the host fails, when its tick does not move
 * for PROGRESS_MS (a setup that never ends, a hung loop), or after `limitMs`.
 */
async function withStepHost<T>(
  node: Pick<LiveNode, 'code' | 'name' | 'params' | 'w' | 'h'> & Partial<Pick<LiveNode, 'id' | 'data' | 'pins'>>,
  dpr: number,
  from: number,
  timeline: LiveTimeline | null,
  run: (host: WorldHost, watch: <R>(work: Promise<R | null>) => Promise<R | null>) => Promise<T>,
  options: { onError?: (message: string) => void; limitMs?: number } = {}
): Promise<T> {
  return withStepTurn(async () => {
    const started = absNow()
    let moved = started
    let lastTick = -2
    let failed = false
    const progress = (tick: number): void => {
      if (tick === lastTick) return
      lastTick = tick
      moved = absNow()
    }
    const host = new WorldHost(
      { id: node.id ?? 'step', code: node.code, data: node.data, pins: node.pins, seed: seedOf(node), w: node.w, h: node.h, dpr, params: node.params, mode: 'step', from, clock: HELD, scene: NO_SCENE, timeline, visible: false },
      {
        onAlive: (_frames, tick) => progress(tick),
        onProgress: progress,
        onError: (message) => {
          failed = true
          options.onError?.(message)
        },
        onLost: () => undefined
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

/** Pictures of each world at its moments: one step host per world, from tick 0 forward. */
export async function sceneStills(items: LiveStillRequest[], scale: number): Promise<LiveStill[]> {
  const results = await Promise.all(items.map((item) => itemStills(item, scale)))
  return results.flat()
}

async function itemStills(item: LiveStillRequest, scale: number): Promise<LiveStill[]> {
  const ticks = [...new Set(item.moments.map((moment) => tickOf(moment.t)))].sort((a, b) => a - b)
  const pictures = new Map<number, LiveFrame>()
  await withStepHost(item.node, stillScale(item.node, scale), 0, item.timeline, async (host, watch) => {
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

/** A picture of a world that has no host on the board: a fresh host at the tick of item time t. */
export async function stillAt(node: LiveNode, params: Record<string, number>, t: number, scale: number): Promise<LiveFrame | null> {
  const tick = tickOf(t)
  return withStepHost({ ...node, params }, stillScale(node, scale), tick, null, (host, watch) => watch(host.advance(tick, true)))
}

/**
 * Check a world before a scene plays it: run its setup and its first ticks
 * in a step host, and return its first error (syntax, a failed import, a
 * runtime error), or null. A world still busy after CHECK_MS (a slow import,
 * a setup that waits) passes.
 */
export async function worldError(code: string, params: Record<string, number>, size: [number, number] = [480, 360], data?: unknown): Promise<string | null> {
  let error: string | null = null
  await withStepHost(
    { code, params, data, w: size[0], h: size[1] },
    1,
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
