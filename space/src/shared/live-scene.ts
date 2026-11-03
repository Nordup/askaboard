/**
 * Live scenes (write_scene, preview_scene, play_scene): the description a scene program builds in the
 * sandbox (main/live-prelude.js), which the renderer turns into board items
 * and plays (renderer/src/live/). Plain data, no DOM or Node imports.
 */

import type { CommitRecord } from './scene-story'

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
  /** Parts of the view that app UI covers (the script panel), in board points; absent when nothing covers it. */
  covered?: Array<SceneBounds & { by: string }>
  /** The learner's canvas in CSS pixels, for camera zoom. */
  viewport: [number, number]
  /** The board's revision (its next sequence number): it changes with every edit of the board, so a draft made before an edit runs again. */
  revision?: number
  /** The open board's path (the stage resets when it changes). */
  board?: string
  /**
   * The renderer's record of the stage: its epoch and, per stage object id, the board items it shows through (node ids, ink group id).
   * first: the stage id of the program's first object (main/live-scene.ts sets it): the ids of a program that does not run stay empty.
   */
  stage?: { epoch: string; items: Record<string, string[]>; first?: number }
  /**
   * A new version of a scene runs at that scene's place on the stage: the items (ids and names)
   * of that scene (earlier: true) and of the scenes after it, which do not exist there yet, by
   * the scene's name. Absent for a program that runs at the end of the stage.
   */
  ahead?: Record<string, { scene: string; earlier: boolean }>
}

/** What the host adds to the context before a run (main process). */
export interface SceneRunOptions {
  /** Seed of the program's Math.random (the same in both passes of a run). */
  seed: number
  /** Cut the scene at this time (play_scene cut): what starts later is dropped, what runs then holds. */
  cutAt?: number | null
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
  /** A filled shape the pen draws (pen: true with a fill): its outline is drawn by hand, then the fill shows. */
  pen?: boolean
  /** Text only: font size in board points. */
  size?: number
}

/** A link as it leaves the stage: world is the world's stage id, and at is the anchor that stands in for the point. */
export type StageFollows =
  | { world: number; point: string; at: [number, number] }
  | { ends: [{ world: number; point: string } | [number, number], { world: number; point: string } | [number, number]]; at: [[number, number], [number, number]]; head?: number }

interface SceneObjectBase {
  id: number
  api: string
  /** The item follows a point of a world. */
  follows?: StageFollows
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
  /** The object's key in the scene that made it (its name, name#2 …, else o<n>; stage/live-prelude.js keyFor): only on objects this scene made. The record's story.items link it to board nodes. */
  key?: string
  /** The group that holds this object. */
  parent?: number
  /** Stage object id: the same object in every scene of the stage (see main/live-scene.ts). */
  sid?: number
  /** The object was made by an earlier scene of the stage: it is already on the board (its items are reused). */
  carry?: boolean
  /** A carried object's state at the start of this scene (the end of the scenes before), per property. */
  base?: Partial<Record<SceneProp, number | string>>
  /**
   * Geometry that can change over time (values, attached labels, tweened
   * options): it is sampled in the sandbox, and each sample holds from its t
   * until the next one. Seeds and samples go to the board as frames
   * (shared/frames.ts, by sid). The object's own fields hold its end seed.
   */
  dynamic?: boolean
  /** The object's seeds differ from each other. */
  changes?: boolean
  /** A carried object whose seeds equal its baked state: its board items stay as they are, and it shows only if the sweep gives it samples. */
  unchanged?: boolean
}

/** The geometry of a changing object at one time. Only the fields of its kind are set. */
export interface SceneSample {
  t: number
  bounds: SceneBounds
  /** shape */
  d?: string
  /** ink */
  lines?: Array<Array<[number, number] | [number, number, number]>>
  /** text */
  text?: string
  /** stroke width (shape, ink) */
  width?: number
  fill?: string
  fillOpacity?: number
  /** live */
  params?: Record<string, number>
}

/** Ink: its points (strokes, and shapes with pen: true, whose points the stage makes: shared/ink-points.ts). */
export interface SceneInkObject extends SceneObjectBase {
  kind: 'ink'
  style: SceneStyle
  lines: Array<Array<[number, number] | [number, number, number]>>
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

/** A world. */
export interface SceneLiveObject extends SceneObjectBase {
  kind: 'live'
  code: string
  width: number
  height: number
  params: Record<string, number>
  data?: unknown
  style: SceneStyle
  /** The program line of the world() call, for errors; file: its module in boards/scenes/ (none: the inline code). */
  line?: number
  file?: string
}

/**
 * A plain-data node draft (the HTML converter's output, renderer/board/html.ts
 * Draft): kind, style, x, y (inside a free frame), text, markup, src, name, children.
 */
export interface SceneDraft {
  kind: 'frame' | 'text' | 'svg' | 'image'
  name?: string
  style: Record<string, string>
  x: number
  y: number
  text?: string
  /** Text only: degrees, clockwise (TextNode.rotation). */
  rotation?: number
  markup?: string
  src?: string
  children: SceneDraft[]
}

/** Where html() puts its nodes: at the top level (bounds), or into an existing frame, or in place of an item. */
export interface SceneHtmlPlace {
  /** A board item (node id) the html goes into (insert) or replaces (replace). */
  ref: string
  mode: 'insert' | 'replace'
  /** insert: the position among the frame's children (default: last). */
  index?: number
}

/**
 * Board material from HTML (html(), image(), a copy of material): one root
 * node with its subtree, made from drafts. Its parts (the root's children)
 * reveal one after another when it is drawn.
 */
export interface SceneHtmlObject extends SceneObjectBase {
  kind: 'html'
  drafts: SceneDraft[]
  /** Into an existing frame or in place of an item; else at bounds.x, bounds.y at the top level. */
  place?: SceneHtmlPlace
  /** A turned root: where its own box (the node's x, y) is from the top-left of bounds, which are its bounds on the board. */
  offset?: [number, number]
  style: SceneStyle
}

/** One part of an html object (a child of its root, by index): revealed, faded or recoloured on its own. */
export interface ScenePartObject extends SceneObjectBase {
  kind: 'part'
  /** The html object (its parent) and the part's index among the root's children. */
  index: number
  style: SceneStyle
}

export type SceneObjectDesc = SceneInkObject | SceneShapeObject | SceneTextObject | SceneGroupObject | SceneNodeObject | SceneLiveObject | SceneHtmlObject | ScenePartObject

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
  /** Cut: the track holds its value at this time from then on. */
  until?: number
}

/** A camera move: the learner's view glides to center and zoom over [start, start + dur]. */
export interface SceneCameraAction {
  start: number
  dur: number
  center: [number, number]
  zoom: number
  ease: SceneEase
  /** The camera goes to this point of a world and stays on it. world: the stage id, then the node id. */
  follows?: { world: number | string; point: string }
}

/** The pointer (a tutor's hand) glides to `to` over [start, start + dur] and rests there; null hides it. */
export interface ScenePointerAction {
  start: number
  dur: number
  to: [number, number] | null
  /** The pointer goes to this point of a world and stays on it; to is the world's anchor. */
  follows?: { world: number | string; point: string }
}

/** Where a spoken line lives. clip: the WAV path relative to the learning folder (.learning-space/voice/<sha>.wav); from: the second in the WAV where the line starts. */
export interface SceneVoice {
  clip: string
  from: number
}

/** A line (say) on the timeline: text the learner reads, and hears when it has a voice. dur is its reading time, or the length of its voice. */
export interface SceneCue {
  text: string
  at: number
  dur: number
  /** Marks ([[name]] in the line): when the word after each is reached (scene time), and its character index in text. */
  marks?: Array<{ name: string; at: number; char: number }>
  /** The line's audio: the app read it aloud (main/voice.ts). */
  voice?: SceneVoice
}

export interface SceneStep {
  name: string
  at: number
  /** Playback stops here until play_scene resume continues it. */
  pause?: boolean
  /** The first step named after the scene, for lines before the first step() (shared/scene-story.ts stepLines). */
  lead?: boolean
  /** The say() lines of this step: indexes into the scene's cues (stepLines). */
  lines?: number[]
}

/**
 * edit(): an item's text or style changes at `at` (styles glide over dur).
 * style values are CSS strings (null removes the key); text is the text node's markup.
 */
export interface SceneEdit {
  obj: number
  at: number
  dur: number
  ease: SceneEase
  text?: string
  style?: Record<string, string | null>
}

/** move(item, {into}): the item becomes a child of a frame at `start` and glides to its new place over dur. */
export interface SceneReparent {
  obj: number
  /** The frame: a board node id, or an object of this scene (an html object). */
  into: { ref: string } | { obj: number }
  /** The position among the frame's children (default: last). */
  index?: number
  start: number
  dur: number
  ease: SceneEase
}

export interface SceneDescription {
  objects: SceneObjectDesc[]
  actions: SceneTrack[]
  edits?: SceneEdit[]
  reparents?: SceneReparent[]
  steps: SceneStep[]
  duration: number
  logs: string[]
  camera: SceneCameraAction[]
  pointer: ScenePointerAction[]
  cues: SceneCue[]
  /** The stage epoch the program ran in. */
  stage?: string
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

/** The result of a committed scene (play_scene start), as the agent sees it. */
export interface SceneResult {
  scene: string
  duration_s: number
  /** Seconds until this scene starts playing (0: now). */
  starts_in_s: number
  steps: Array<{ name: string; at_s: number; pause?: boolean }>
  items: SceneItem[]
  cues: Array<{ text: string; at_s: number; dur_s: number; marks?: Record<string, number> }>
  log: string[]
  /** For main's scene record (main/scene-store.ts), never for the agent: the board's id, the story and the revert. */
  record?: CommitRecord
}

/** A moment of a scene (preview_scene): its end, the end of a step (1-based number or name), a time in seconds, or one frame per step. */
export type FrameMoment = { kind: 'end' } | { kind: 'steps' } | { kind: 'step'; step: number | string } | { kind: 't'; t: number }

/** What preview_scene frames show: everything the scene makes or touches, the learner's view, a board rect, or items (object names or item ids). */
export type FramePart = { kind: 'scene' } | { kind: 'view' } | { kind: 'region'; rect: SceneBounds } | { kind: 'items'; items: string[] }

/** A scene's steps as the agent reads them (write_scene): the one rule for a step's number, start and length. */
export function sceneSteps(steps: Array<{ name: string; at: number; pause?: boolean }>, duration: number): DraftInfo['steps'] {
  const r3 = (value: number): number => Math.round(value * 1000) / 1000
  return steps.map((step, i) => {
    const next = steps.slice(i + 1).find((entry) => entry.at > step.at + 1e-6)
    return { number: i + 1, name: step.name, start_s: r3(step.at), length_s: r3((next ? next.at : duration) - step.at), ...(step.pause ? { pause: true } : {}) }
  })
}

/** What write_scene reports about a draft: compiled against the board now, committing nothing. */
export interface DraftInfo {
  duration_s: number
  steps: Array<{ number: number; name: string; start_s: number; length_s: number; pause?: boolean }>
  items: { total: number; by_kind: Record<string, number>; named: Array<{ name: string; kind: string; step?: string }>; removed_by_end: number }
  cues: Array<{ text: string; at_s: number; dur_s: number }>
  log: string[]
}

/** play_scene's status. */
export interface SceneStatus {
  playing: boolean
  scene: string | null
  name: string | null
  t: number | null
  duration: number | null
  step: string | null
  paused: boolean
  /** The scene holds at what is ready, and goes on by itself. */
  held?: boolean
  /** When a scene stands paused: why, which scene, its step and time. */
  paused_by?: 'pause step' | 'learner drawing' | 'play_scene pause'
  paused_scene?: string
  paused_name?: string | null
  paused_step?: string | null
  paused_t?: number
  queue: Array<{ scene: string; name: string | null; duration_s: number }>
}

export const SCENE_EASES: Record<SceneEase, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  smooth: (t) => t * t * (3 - 2 * t)
}

/*
 * The scene logic that the stage (stage/live-prelude.js, which gets it from
 * stage/worker.ts) and the board use alike: the eases above, the value of a
 * number track, and the seeded random.
 */

/** A number track's value at t (at or after its start): `to` once its change is complete, else eased from `from`. A cut track holds its value at the cut. */
export function trackNumber(a: Pick<SceneTrack, 'start' | 'dur' | 'until' | 'ease'>, from: number, to: number, t: number): number {
  const tt = a.until !== undefined ? Math.min(t, a.until) : t
  return tt >= a.start + a.dur ? to : from + (to - from) * SCENE_EASES[a.ease]((tt - a.start) / a.dur)
}

/** A seeded random source (mulberry32): the same seed gives the same numbers. A scene that runs again (a restage, a rebuild of the stage) gets the same numbers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
