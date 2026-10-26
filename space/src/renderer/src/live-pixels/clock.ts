import type { ScenePlay } from '../live/compile'
import { BLEND_GAP, paramSamplesOf, paramsAtTime, type ParamSample } from '../live/params'

/**
 * The time of live items (shader, canvas and program items): one contract
 * for all three kinds.
 *
 * The tick grid, for previews and stills only. Tick k is at item time
 * k / TICK_HZ seconds. Previews and stills step through every tick from the
 * scene's start (tick 0) to the tick of each moment, so a preview shows the
 * same simulation every time. Playback is live and has no grid: each display
 * frame runs one frame at the item clock's time now, at the display's own
 * rate (dt is the time from the last frame).
 *
 * The item clock. While a scene plays the item, item time is the scene's
 * time: a pause holds the item, a seek or a replay moves it. A move back in
 * time starts a fresh host at the new tick. When no scene plays the item, its
 * time runs on in real time from where it was (or from where its scene ended,
 * LiveNode.rest, on a reopened board).
 *
 * Determinism. Math.random is seeded per item (seedOf), so previews repeat.
 * Playback follows the display's frames, so it matches a preview closely
 * only for an item that uses no network, no learner input and no real time
 * (Date, crypto), and exactly only for an item whose picture is a function
 * of time.
 */

/** Ticks per second of item time. */
export const TICK_HZ = 60

/** The tick that shows at item time t (s). */
export function tickOf(t: number): number {
  return Math.max(0, Math.floor(t * TICK_HZ + 1e-6))
}

/** The item time (s) of tick k. */
export function timeOfTick(k: number): number {
  return k / TICK_HZ
}

/** Absolute time in ms (the same scale in the page and in workers). */
export function absNow(): number {
  return performance.timeOrigin + performance.now()
}

/** The scene clock that the player gives an item (live/player.ts). */
export interface SceneClock {
  t: number
  playing: boolean
  step: string | null
  /** The scene's duration. */
  end: number
}

/** The item clock: item time t (s) at absolute time `at` (ms), moving at `rate` (1: real time; 0: held). */
export interface ItemClock {
  t: number
  at: number
  rate: 0 | 1
}

/** What the item's code sees of its scene (program items: `scene`). */
export interface SceneView {
  t: number
  playing: boolean
  active: boolean
  ended: boolean
  step: string | null
}

export function itemTime(clock: ItemClock, at = absNow()): number {
  return clock.t + (clock.rate * (at - clock.at)) / 1000
}

/** The inputs of a scene over item time, for stepping: params samples (live/params.ts) and steps [at, name], both in time order. */
export interface LiveTimeline {
  params: ParamSample[] | null
  steps: Array<[number, string]>
}

/**
 * The timeline of a live item in a scene: the params samples of the scene's
 * live object that targets the item, and the scene's steps. Null when the
 * scene does not play the item.
 */
export function sceneTimelineOf(play: ScenePlay, nodeId: string): LiveTimeline | null {
  for (const object of play.objects) {
    if (play.timeline.object(object.id).kind !== 'live' || !object.targets.some((target) => target.nodeId === nodeId)) continue
    const samples = object.dyn?.kind === 'live' ? paramSamplesOf(object.dyn.samples) : []
    return { params: samples.length ? samples : null, steps: play.steps.map((step) => [step.at, step.name] as [number, string]) }
  }
  return null
}

/** The params at item time t (the evaluator of playback, live/params.ts), over the item's own params. */
export function paramsAt(timeline: LiveTimeline | null, base: Record<string, number>, t: number): Record<string, number> {
  const pick = timeline?.params ? paramsAtTime(timeline.params, t, BLEND_GAP) : null
  return pick ? { ...base, ...pick } : base
}

/** The step at item time t, or null before the first step. */
export function stepAt(timeline: LiveTimeline | null, t: number): string | null {
  let step: string | null = null
  for (const [at, name] of timeline?.steps ?? []) if (at <= t + 1e-6) step = name
  return step
}

/**
 * The seed of an item's Math.random: from its mode, code and name, never
 * from its id. Ids change when a draft is committed, on a replay and on a
 * copy; the seed stays, so a preview and the board run the same numbers.
 * Two items with the same code and name share a seed: give them different
 * names to differ.
 */
export function seedOf(node: { mode: string; code: string; name?: string }): number {
  let hash = 0x811c9dc5
  const text = `${node.mode}\u0000${node.code}\u0000${node.name ?? ''}`
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
