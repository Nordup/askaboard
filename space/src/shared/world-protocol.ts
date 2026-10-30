// The contract between the page (WorldSurface) and the world worker, over one
// MessagePort. See docs/learning-space/one-world-architecture.md.
// Screen values are CSS pixels relative to the board element; the worker scales
// them by dpr. Board values are board points.

export interface WorldCamera {
  /** Board point at the board element's top-left corner. */
  x: number
  y: number
  /** CSS pixels per board point. */
  zoom: number
}

export interface WorldClock {
  t: number
  at: number
  rate: 0 | 1
}

export interface WorldSceneView {
  t: number
  playing: boolean
  active: boolean
  ended: boolean
  step: string | null
}

/** Where a world sits: read from its placeholder in the same paint. */
export interface WorldPlacement {
  id: string
  /** Screen rect of the placeholder. */
  x: number
  y: number
  w: number
  h: number
  opacity: number
  visible: boolean
}

export interface WorldStart {
  id: string
  code: string
  seed: number
  /** The nominal size in board points. */
  w: number
  h: number
  params: Record<string, number>
  mode: 'live' | 'step'
  from: number
  clock: WorldClock
  scene: WorldSceneView
  timeline: { params: Array<[number, Record<string, number>]> | null; steps: Array<[number, string]> } | null
  colors: Record<string, string>
}

export type PageToWorld =
  | { type: 'init'; canvasW: number; canvasH: number; dpr: number; margin: number }
  | { type: 'resize'; canvasW: number; canvasH: number; dpr: number }
  /** Sent on every board paint. seq grows by one each time. */
  | { type: 'view'; seq: number; camera: WorldCamera; placements: WorldPlacement[] }
  | { type: 'add'; world: WorldStart }
  | { type: 'remove'; id: string }
  | { type: 'clock'; id: string; clock: WorldClock; scene: WorldSceneView }
  | { type: 'live'; id: string; clock: WorldClock; scene: WorldSceneView; params: Record<string, number> }
  | { type: 'run'; id: string; on: boolean }
  | { type: 'params'; id: string; params: Record<string, number> }
  | { type: 'size'; id: string; w: number; h: number }
  | { type: 'advance'; id: string; to: number; capture: boolean; request: number }
  | { type: 'capture'; id: string; request: number }
  | { type: 'ping'; n: number }

export type WorldToPage =
  | { type: 'ready' }
  | { type: 'pong'; n: number }
  /** The frame on screen now was rendered for view seq. */
  | { type: 'rendered'; seq: number }
  | { type: 'alive'; id: string; frames: number; tick: number }
  | { type: 'progress'; id: string; tick: number }
  | { type: 'at'; id: string; request: number; tick: number }
  /** dx, dy: where the picture's top-left sits from the placeholder's, in board points. */
  | { type: 'frame'; id: string; request: number; tick: number; blob: Blob | null; dx: number; dy: number }
  | { type: 'error'; id: string; message: string }
  | { type: 'lost' }
  | { type: 'input'; id: string; mode: 'none' | 'enter' | 'direct' }
  | { type: 'report'; id: string; values: unknown }
  /** Slice 2: board positions of published points, for one world. */
  | { type: 'points'; id: string; seq: number; points: Record<string, [number, number, boolean]> }
