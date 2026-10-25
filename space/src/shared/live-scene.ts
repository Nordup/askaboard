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
  /** Item names (node names, named ink and group items) → item id; the latest item wins. */
  names: Record<string, string>
  view: SceneBounds
  /** The learner's canvas in CSS pixels, for camera zoom. */
  viewport: [number, number]
}

/** What the host adds to the context before a run (main process). */
export interface SceneRunOptions {
  /** Seed of the program's Math.random (the same in both passes of a run). */
  seed: number
  /** Measured speech durations (s) by line text. */
  durations: Record<string, number>
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
  /**
   * Geometry that changes over time (values, attached labels, tweened options),
   * sampled in the sandbox: each sample holds from its t until the next one.
   * The object's own fields hold the geometry at the end of the scene.
   */
  dyn?: SceneSample[]
}

/** The geometry of a changing object at one time. Only the fields of its kind are set. */
export interface SceneSample {
  t: number
  bounds: SceneBounds
  /** shape, or ink drawn from a path */
  d?: string
  /** ink */
  lines?: Array<Array<[number, number] | [number, number, number]>> | null
  /** text */
  text?: string
  /** stroke width (shape, ink) */
  width?: number
  fill?: string
  fillOpacity?: number
  /** live */
  params?: Record<string, number>
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

/** Live pixels: a fragment shader or a 2D canvas program, drawn every frame by the board. */
export interface SceneLiveObject extends SceneObjectBase {
  kind: 'live'
  mode: 'shader' | 'canvas'
  code: string
  width: number
  height: number
  params: Record<string, number>
}

export type SceneObjectDesc = SceneInkObject | SceneShapeObject | SceneTextObject | SceneGroupObject | SceneNodeObject | SceneLiveObject

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

/** A camera move: the learner's view glides to center and zoom over [start, start + dur]. */
export interface SceneCameraAction {
  start: number
  dur: number
  center: [number, number]
  zoom: number
  ease: SceneEase
}

/** The pointer (a tutor's hand) glides to `to` over [start, start + dur] and rests there; null hides it. */
export interface ScenePointerAction {
  start: number
  dur: number
  to: [number, number] | null
}

/** A spoken line on the timeline. */
export interface SceneCue {
  text: string
  at: number
  dur: number
}

export interface SceneStep {
  name: string
  at: number
  /** Playback stops here until scene_control resumes it. */
  pause?: boolean
}

export interface SceneDescription {
  objects: SceneObjectDesc[]
  actions: SceneTrack[]
  steps: SceneStep[]
  duration: number
  logs: string[]
  warnings: string[]
  camera: SceneCameraAction[]
  pointer: ScenePointerAction[]
  cues: SceneCue[]
}

/** One board item a scene made. */
export interface SceneItem {
  id: string
  kind: string
  name?: string
  bounds: SceneBounds | null
  /** The step it appears in. */
  step?: string
}

/** The run_scene result, as the agent sees it. */
export interface SceneResult {
  scene: string
  duration_s: number
  /** Seconds until this scene starts playing (0: now). */
  starts_in_s: number
  steps: Array<{ name: string; at_s: number; pause?: boolean }>
  items: SceneItem[]
  cues: Array<{ text: string; at_s: number; dur_s: number }>
  log: string[]
  warnings: string[]
}

/** scene_control's status. */
export interface SceneStatus {
  playing: boolean
  scene: string | null
  name: string | null
  t: number | null
  duration: number | null
  step: string | null
  paused: boolean
  queue: Array<{ scene: string; name: string | null; duration_s: number }>
}

export const SCENE_EASES: Record<SceneEase, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  smooth: (t) => t * t * (3 - 2 * t)
}
