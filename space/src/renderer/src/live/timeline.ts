import { SCENE_EASES, type SceneDescription, type SceneObjectDesc, type SceneProp, type SceneTrack } from '@shared/live-scene'
import type { Point } from '../board/types'
import { mixColors, sceneColor } from './colors'

/**
 * Evaluating a scene's timeline at a time: the same rules as the sandbox
 * (main/live-prelude.js). For each property, the actions are in start order;
 * the last one that has started gives the value.
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

export class Timeline {
  readonly tracks: Array<Partial<Record<SceneProp, SceneTrack[]>>>

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
  }

  object(id: number): SceneObjectDesc {
    return this.desc.objects[id]
  }

  base(object: SceneObjectDesc, prop: SceneProp): number | string | undefined {
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

  value(id: number, prop: SceneProp, t: number): number | string | undefined {
    const object = this.desc.objects[id]
    let value = this.base(object, prop)
    for (const a of this.tracks[id][prop] ?? []) {
      if (a.start > t) break
      const from = a.from ?? value
      if (t >= a.start + a.dur) value = a.to
      else if (typeof a.to === 'number' && typeof from === 'number') value = from + (a.to - from) * SCENE_EASES[a.ease]((t - a.start) / a.dur)
      else value = a.to
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
    let value = typeof base === 'string' ? sceneColor(base).hex : undefined
    for (const a of this.tracks[id].color ?? []) {
      if (a.start > t) break
      const from = typeof a.from === 'string' ? sceneColor(a.from).hex : value
      const to = sceneColor(String(a.to)).hex
      if (t >= a.start + a.dur || !from) value = to
      else value = mixColors(from, to, SCENE_EASES[a.ease]((t - a.start) / a.dur))
    }
    return value
  }

  hasTrack(id: number, prop: SceneProp): boolean {
    return (this.tracks[id][prop]?.length ?? 0) > 0
  }

  /** The object's world transform at t (its groups' transforms included). */
  matrix(id: number, t: number): Matrix {
    const object = this.desc.objects[id]
    const s = this.number(id, 'scale', t)
    const r = (this.number(id, 'rotate', t) * Math.PI) / 180
    const ox = this.number(id, 'x', t)
    const oy = this.number(id, 'y', t)
    const [px, py] = object.pivot
    const a = Math.cos(r) * s
    const b = Math.sin(r) * s
    const own: Matrix = [a, b, -b, a, px + ox - (a * px - b * py), py + oy - (b * px + a * py)]
    return object.parent === undefined ? own : multiply(this.matrix(object.parent, t), own)
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
        for (const a of list ?? []) end = Math.max(end, a.start + a.dur)
      }
    }
    return end
  }
}
