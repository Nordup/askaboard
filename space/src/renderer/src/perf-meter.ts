import { useEffect, useState } from 'react'
import type { WorldStats } from '@shared/world-protocol'
import { listenWorldStats } from './live-pixels/world/surface'

/**
 * The page's render meter, and the one owner of this state: paints of the page,
 * long tasks of the main thread, the last snapshot of the world worker. While
 * off, it has no loop, no observer and no listener. The render benchmark reads it
 * through window.__spaceDev.perf (scripts/perf/render.mjs). In the app, the performance
 * pill runs it through usePerfReading.
 */

const WINDOW_MS = 10_000
/** A frame longer than this missed the display's beat. */
const DROPPED_MS = 20
/** A worker sends one snapshot per second. An older snapshot means that no worker runs now. */
const WORLD_FRESH_MS = 2500

export interface PerfReading {
  /** performance.now() of this reading. */
  at: number
  /** False: the meter is off, and the numbers below are empty. */
  running: boolean
  /** Paints in the last second. */
  fps: number
  /** The longest frame in the last 10 s, in ms. */
  worstFrameMs: number
  /** Frames over 20 ms in the last 10 s. */
  droppedFrames: number
  /** Long main-thread tasks in the last 10 s, and their total. Null: this browser does not report them. */
  longTasks: number | null
  longTaskMs: number | null
  /** The world worker's last second. Null: no world renders. */
  world: WorldStats | null
}

/** [time, frame length] of each paint in the window. */
let frames: Array<[number, number]> = []
let tasks: Array<[number, number]> = []
let raf = 0
let lastPaint = 0
let observer: PerformanceObserver | null = null
let world: WorldStats | null = null
let worldAt = 0

function paint(now: number): void {
  if (lastPaint) frames.push([now, now - lastPaint])
  lastPaint = now
  let old = 0
  while (old < frames.length && now - frames[old][0] > WINDOW_MS) old++
  if (old) frames.splice(0, old)
  raf = requestAnimationFrame(paint)
}

function watchLongTasks(): void {
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) tasks.push([entry.startTime, entry.duration])
    const from = performance.now() - WINDOW_MS
    tasks = tasks.filter(([at]) => at >= from)
  })
  observer.observe({ type: 'longtask' })
}

/** A page that was hidden paints nothing, so the gap to its next paint is no frame. */
function restartFrames(): void {
  lastPaint = 0
}

function start(): void {
  if (raf) return
  raf = requestAnimationFrame(paint)
  document.addEventListener('visibilitychange', restartFrames)
  watchLongTasks()
  listenWorldStats((stats) => {
    world = stats
    worldAt = performance.now()
  })
}

function stop(): void {
  if (!raf) return
  cancelAnimationFrame(raf)
  raf = 0
  document.removeEventListener('visibilitychange', restartFrames)
  observer?.disconnect()
  observer = null
  listenWorldStats(null)
  frames = []
  tasks = []
  lastPaint = 0
  world = null
}

function read(): PerfReading {
  const now = performance.now()
  const recent = frames.filter(([at]) => now - at <= WINDOW_MS)
  const taskRecent = tasks.filter(([at]) => now - at <= WINDOW_MS)
  return {
    at: now,
    running: raf !== 0,
    fps: recent.filter(([at]) => now - at <= 1000).length,
    worstFrameMs: recent.reduce((worst, [, ms]) => Math.max(worst, ms), 0),
    droppedFrames: recent.filter(([, ms]) => ms > DROPPED_MS).length,
    longTasks: observer ? taskRecent.length : null,
    longTaskMs: observer ? taskRecent.reduce((sum, [, ms]) => sum + ms, 0) : null,
    world: world && now - worldAt < WORLD_FRESH_MS ? world : null
  }
}

export const perfMeter = { start, stop, read }

/** The meter runs for as long as the caller is mounted. Null: the first second has no reading yet. */
export function usePerfReading(): PerfReading | null {
  const [reading, setReading] = useState<PerfReading | null>(null)
  useEffect(() => {
    start()
    const tick = setInterval(() => setReading(read()), 1000)
    return () => {
      clearInterval(tick)
      stop()
    }
  }, [])
  return reading
}
