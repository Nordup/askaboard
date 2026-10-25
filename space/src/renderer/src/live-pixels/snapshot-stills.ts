import type { LiveClock } from './program'

/**
 * The snapshot window (agent screenshots, storyboards) shows live items as
 * still images. For a storyboard frame it shows each item at that moment of
 * the scene: the scene clock and the params of that moment come with the
 * request (SnapshotView sets them before it renders), and a program item is
 * run in a hidden frame until it paints, then shown as its picture. The
 * snapshot waits for those pictures (stillsSettled) before it is captured.
 */

let clocks = new Map<string, LiveClock>()
let params = new Map<string, Record<string, number>>()
const pending = new Set<Promise<unknown>>()

export function setSnapshotPlayback(playback: { overrides?: Array<[string, unknown]>; clocks?: Array<[string, unknown]> } | null | undefined): void {
  clocks = new Map((playback?.clocks ?? []) as Array<[string, LiveClock]>)
  params = new Map()
  for (const [id, override] of playback?.overrides ?? []) {
    const p = (override as { params?: Record<string, number> } | null)?.params
    if (p) params.set(id, p)
  }
}

export function snapshotClock(id: string): LiveClock | null {
  return clocks.get(id) ?? null
}

export function snapshotParams(id: string): Record<string, number> | undefined {
  return params.get(id)
}

export function trackStill(promise: Promise<unknown>): void {
  pending.add(promise)
  void promise.finally(() => pending.delete(promise))
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * Every picture being made has its image in the page, or gave up. Each
 * picture ends itself (a program item asks for its still after 3 s without
 * progress), so there is no limit here: a storyboard run of a long scene
 * takes as long as the program needs to compute up to the frame's moment.
 */
export async function stillsSettled(): Promise<void> {
  if (!pending.size) return
  while (pending.size) await Promise.all([...pending])
  // Let React put the images in the page.
  await frame()
  await frame()
}
