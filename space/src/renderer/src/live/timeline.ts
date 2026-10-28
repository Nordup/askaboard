import { SCENE_EASES, trackNumber, type SceneDescription, type SceneObjectDesc, type SceneProp, type SceneTrack } from '@shared/live-scene'
import type { Point } from '../board/types'
import { drawColor, mixColors } from './colors'

/**
 * Evaluating a scene's timeline at a time: the same rules as the sandbox
 * (main/live-prelude.js). For each property, the actions are in start order;
 * the last one that has started gives the value.
 *
 * Playback asks for the values of the same objects frame after frame. So each
 * property keeps a cursor (the last action that has started), and each object
 * keeps its world transform of the last time it was asked for.
 */

/** A 2D affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

export function apply(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
}

export function isIdentity(m: Matrix): boolean {
  return Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01
}

/** The scale of a matrix (the square root of its area factor). */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
}

/** One property's actions of one object, in start order, and the index of the last action that started at the last lookup. */
interface Lane {
  list: SceneTrack[]
  at: number
}

/** Forward steps of the cursor before a lookup uses a binary search. */
const CURSOR_STEPS = 4

/** The index of the last action of the lane that started at or before t (-1: none). */
function started(lane: Lane, t: number): number {
  const list = lane.list
  let i = lane.at
  if (i < 0 || list[i].start <= t) {
    // Forward playback: the cursor moves on by a step or two.
    let steps = 0
    while (i + 1 < list.length && list[i + 1].start <= t && steps < CURSOR_STEPS) {
      i++
      steps++
    }
    if (i + 1 >= list.length || list[i + 1].start > t) {
      lane.at = i
      return i
    }
  }
  // A seek: a binary search.
  let lo = 0
  let hi = list.length - 1
  i = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].start <= t) {
      i = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  lane.at = i
  return i
}

/** True when the action's change is complete at t (a cut action holds its value at the cut, so its change is never complete). */
const complete = (a: SceneTrack, t: number): boolean => (a.until !== undefined ? Math.min(t, a.until) : t) >= a.start + a.dur

export class Timeline {
  readonly tracks: Array<Partial<Record<SceneProp, SceneTrack[]>>>
  private readonly lanes: Array<Partial<Record<SceneProp, Lane>>>
  /** Each object's world transform at the time of its last lookup: the children of a group use it in the same frame. */
  private readonly worlds: Array<{ t: number; m: Matrix } | undefined>

  constructor(
    readonly desc: SceneDescription,
    /** The colour of an existing node, for a colour track without `from`. */
    private readonly nodeColor: (object: SceneObjectDesc) => string | undefined
  ) {
    this.tracks = desc.objects.map(() => ({}))
    for (const action of desc.actions) {
      const list = (this.tracks[action.obj][action.prop] ??= [])
      list.push(action)
    }
    this.lanes = this.tracks.map((tracks) => {
      const lanes: Partial<Record<SceneProp, Lane>> = {}
      for (const [prop, list] of Object.entries(tracks) as Array<[SceneProp, SceneTrack[]]>) lanes[prop] = { list, at: -1 }
      return lanes
    })
    this.worlds = desc.objects.map(() => undefined)
  }

  object(id: number): SceneObjectDesc {
    return this.desc.objects[id]
  }

  base(object: SceneObjectDesc, prop: SceneProp): number | string | undefined {
    // A carried object starts where the scenes before left it.
    const carried = object.base?.[prop]
    if (carried !== undefined) return carried
    switch (prop) {
      case 'x':
      case 'y':
      case 'rotate':
        return 0
      case 'scale':
      case 'opacity':
        return 1
      case 'draw':
      case 'fill':
        return object.vis === 'hidden' ? 0 : 1
      case 'color':
        return 'style' in object ? object.style.color : this.nodeColor(object)
    }
  }

  /**
   * The value at t. Each action starts from the value of the actions before
   * it. An action whose value does not depend on them (it has its own `from`,
   * its value is not a number, or its change is complete) starts the sum
   * again: the work starts at the last such action.
   */
  value(id: number, prop: SceneProp, t: number): number | string | undefined {
    const object = this.desc.objects[id]
    const lane = this.lanes[id][prop]
    if (!lane) return this.base(object, prop)
    const list = lane.list
    const k = started(lane, t)
    let r = k
    while (r >= 0 && list[r].from === undefined && typeof list[r].to === 'number' && !complete(list[r], t)) r--
    let value = r < 0 ? this.base(object, prop) : undefined
    for (let j = Math.max(0, r); j <= k; j++) {
      const a = list[j]
      const from = a.from ?? value
      value = typeof a.to === 'number' && typeof from === 'number' ? trackNumber(a, from, a.to, t) : a.to
    }
    return value
  }

  number(id: number, prop: SceneProp, t: number): number {
    const value = this.value(id, prop, t)
    return typeof value === 'number' ? value : 0
  }

  /** The colour now, as a concrete colour (blended while a colour change runs); undefined when unknown. */
  color(id: number, t: number): string | undefined {
    const object = this.desc.objects[id]
    const base = this.base(object, 'color')
    const lane = this.lanes[id].color
    if (!lane) return typeof base === 'string' ? drawColor(base).hex : undefined
    const list = lane.list
    const k = started(lane, t)
    // As in value(): the work starts at the last action that does not depend on the ones before it.
    let r = k
    while (r >= 0 && typeof list[r].from !== 'string' && !complete(list[r], t)) r--
    let value = r < 0 && typeof base === 'string' ? drawColor(base).hex : undefined
    for (let j = Math.max(0, r); j <= k; j++) {
      const a = list[j]
      const from = typeof a.from === 'string' ? drawColor(a.from).hex : value
      const to = drawColor(String(a.to)).hex
      const tt = a.until !== undefined ? Math.min(t, a.until) : t
      if (tt >= a.start + a.dur || !from) value = to
      else value = mixColors(from, to, SCENE_EASES[a.ease]((tt - a.start) / a.dur))
    }
    return value
  }

  hasTrack(id: number, prop: SceneProp): boolean {
    return (this.tracks[id][prop]?.length ?? 0) > 0
  }

  /** The object's world transform at t (its groups' transforms included). The result is shared: do not change it. */
  matrix(id: number, t: number): Matrix {
    const memo = this.worlds[id]
    if (memo && memo.t === t) return memo.m
    const object = this.desc.objects[id]
    const s = this.number(id, 'scale', t)
    const r = (this.number(id, 'rotate', t) * Math.PI) / 180
    const ox = this.number(id, 'x', t)
    const oy = this.number(id, 'y', t)
    const [px, py] = object.pivot
    const a = Math.cos(r) * s
    const b = Math.sin(r) * s
    const own: Matrix = [a, b, -b, a, px + ox - (a * px - b * py), py + oy - (b * px + a * py)]
    const m = object.parent === undefined ? own : multiply(this.matrix(object.parent, t), own)
    if (memo) {
      memo.t = t
      memo.m = m
    } else this.worlds[id] = { t, m }
    return m
  }

  /** True when any transform track of this object or its groups is still running at t. */
  moving(id: number, t: number): boolean {
    for (let current: number | undefined = id; current !== undefined; current = this.desc.objects[current].parent) {
      for (const prop of ['x', 'y', 'scale', 'rotate'] as const) {
        for (const a of this.tracks[current][prop] ?? []) if (t < a.start + a.dur) return true
      }
    }
    return false
  }

  /** The time after the object's last action (and its groups' transform actions). */
  settled(id: number): number {
    let end = this.desc.objects[id].created
    for (let current: number | undefined = id; current !== undefined; current = this.desc.objects[current].parent) {
      for (const [prop, list] of Object.entries(this.tracks[current])) {
        if (current !== id && !['x', 'y', 'scale', 'rotate'].includes(prop)) continue
        for (const a of list ?? []) end = Math.max(end, Math.min(a.start + a.dur, a.until ?? Infinity))
      }
    }
    return end
  }

  /**
   * The time when the object's look starts to change: its creation, its first
   * action, or the first transform action of one of its groups. Before it,
   * the object looks the same at every time.
   */
  firstChange(id: number): number {
    let start = this.desc.objects[id].created
    for (let current: number | undefined = id; current !== undefined; current = this.desc.objects[current].parent) {
      for (const [prop, list] of Object.entries(this.tracks[current])) {
        if (current !== id && !['x', 'y', 'scale', 'rotate'].includes(prop)) continue
        if (list?.length) start = Math.min(start, list[0].start)
      }
    }
    return start
  }
}
