/**
 * Live scenes (run_scene): the description a scene program builds in the
 * sandbox (main/live-prelude.js), which the renderer turns into board items
 * and plays (renderer/src/live/). Plain data, no DOM or Node imports.
 */

/** A rectangle in board points. */
export interface SceneBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What the sandbox knows about the board: every node and ink group, and the learner's view. */
export interface SceneContext {
  nodes: Record<string, { kind: string; name?: string; author?: string; bounds: SceneBounds }>
  view: SceneBounds
}

export interface SceneStyle {
  /** A colour name (accent, good, …), a token or a CSS colour. */
  color: string
  width: number
  opacity: number
  fill?: string
  gradient?: string[]
  hatch?: string
  fillOpacity?: number
  dash?: number[]
  jitter?: number
  tool?: 'pen' | 'highlighter'
  /** Text only: font size in board points. */
  size?: number
}

interface SceneObjectBase {
  id: number
  api: string
  /** When the object was made (s); an object shown without a reveal appears then. */
  created: number
  /** hidden: invisible until a reveal action; shown: visible from `created`. */
  vis: 'hidden' | 'shown'
  /** Faded out or erased at the end: not on the board afterwards. */
  removed: boolean
  /** Bounds before any transform (text: an estimate). */
  bounds: SceneBounds
  /** The centre of rotation and scaling. */
  pivot: [number, number]
  name?: string
  /** The group that holds this object. */
  parent?: number
}

/** Ink: explicit polylines, or a path `d` that the app samples (a shape with pen: true). */
export interface SceneInkObject extends SceneObjectBase {
  kind: 'ink'
  style: SceneStyle
  lines: Array<Array<[number, number] | [number, number, number]>> | null
  d?: string
  pressure: boolean
}

export interface SceneShapeObject extends SceneObjectBase {
  kind: 'shape'
  style: SceneStyle
  d: string
}

export interface SceneTextObject extends SceneObjectBase {
  kind: 'text'
  style: SceneStyle
  text: string
  math: boolean
  at: [number, number] | null
  center: [number, number] | null
}

export interface SceneGroupObject extends SceneObjectBase {
  kind: 'group'
  members: number[]
}

/** An item that was on the board before the scene (a node id or an ink group id). */
export interface SceneNodeObject extends SceneObjectBase {
  kind: 'node'
  ref: string
}

export type SceneObjectDesc = SceneInkObject | SceneShapeObject | SceneTextObject | SceneGroupObject | SceneNodeObject

/** Animatable properties. draw and fill are 0..1 shares; x, y are offsets; rotate is in degrees. */
export type SceneProp = 'x' | 'y' | 'scale' | 'rotate' | 'opacity' | 'color' | 'draw' | 'fill'

export type SceneEase = 'linear' | 'in' | 'out' | 'inOut' | 'smooth'

/** One change of one property of one object, from `from` to `to` over [start, start + dur]. */
export interface SceneTrack {
  obj: number
  prop: SceneProp
  start: number
  dur: number
  /** Missing for the colour of an existing node: the app reads it. */
  from?: number | string
  to: number | string
  ease: SceneEase
}

export interface SceneDescription {
  objects: SceneObjectDesc[]
  actions: SceneTrack[]
  steps: Array<{ name: string; at: number }>
  duration: number
  logs: string[]
  warnings: string[]
}

/** The run_scene result, as the agent sees it. */
export interface SceneResult {
  scene: string
  duration_s: number
  steps: Array<{ name: string; at_s: number }>
  items: string[]
  log: string[]
  warnings: string[]
}

export const SCENE_EASES: Record<SceneEase, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  smooth: (t) => t * t * (3 - 2 * t)
}
