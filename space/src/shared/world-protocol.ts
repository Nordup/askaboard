// The contract between the page (WorldSurface) and the world worker, over one
// MessagePort. See docs/learning-space/one-world-architecture.md.
// Board values are board points. Pixels are device pixels of the surface.

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

/**
 * One run of a world's code. A seek or a restart makes a new generation of the
 * same node, and the old picture stays until the new one is shown.
 */
export interface WorldKey {
  node: string
  generation: number
}

/** The state of a world on the board, from its node and the playback overrides. */
export interface WorldPlacement extends WorldKey {
  /** The nominal rect in board points, before the transform. */
  x: number
  y: number
  w: number
  h: number
  /** 2D affine [a, b, c, d, e, f], applied to the rect around its centre. */
  matrix: [number, number, number, number, number, number]
  opacity: number
  /** Share of the world revealed by draw(), 0..1. */
  reveal: number
  /** Order on the board: a larger z is composited later. */
  z: number
  /** False while a new generation catches up: it ticks but shows nothing. */
  shown: boolean
}

export interface WorldStart extends WorldKey {
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
  /** A JSON value for the world's code: world.data. */
  data?: unknown
}

export type PageToWorld =
  /** width and height: board element in CSS pixels. margin: overscan in CSS pixels per side. */
  | { type: 'init'; width: number; height: number; dpr: number; margin: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  /** Sent when the camera or a placement changes. seq grows by one each time. */
  | { type: 'view'; seq: number; camera: WorldCamera; placements: WorldPlacement[] }
  /** The page showed picture n; the worker may send the next one. */
  | { type: 'presented'; n: number }
  | { type: 'add'; world: WorldStart }
  | { type: 'remove'; key: WorldKey }
  | { type: 'clock'; key: WorldKey; clock: WorldClock; scene: WorldSceneView }
  | { type: 'live'; key: WorldKey; clock: WorldClock; scene: WorldSceneView; params: Record<string, number> }
  | { type: 'run'; key: WorldKey; on: boolean }
  | { type: 'params'; key: WorldKey; params: Record<string, number> }
  | { type: 'size'; key: WorldKey; w: number; h: number }
  | { type: 'advance'; key: WorldKey; to: number; capture: boolean; request: number }
  | { type: 'capture'; key: WorldKey; request: number }
  | { type: 'ping'; n: number }

/** A still of one world, larger than its nominal rect when it needs to be. */
export interface WorldStill {
  blob: Blob | null
  /** Where the picture sits, in board points, from the nominal rect's top-left. */
  x: number
  y: number
  w: number
  h: number
  /** The world's published points: [x, y, visible], with x and y from the nominal rect's top-left, as above. */
  points?: Record<string, [number, number, boolean]>
}

export type WorldToPage =
  | { type: 'ready' }
  | { type: 'pong'; n: number; running: string | null }
  /**
   * One finished surface picture, transferred. The page shows it in one paint,
   * together with its transform and its points, so everything stays in step.
   */
  | {
      type: 'picture'
      n: number
      /** The view it was rendered for. */
      seq: number
      camera: WorldCamera
      bitmap: ImageBitmap
      /** Board positions of published points by node, name: [x, y, visible], for exactly the state in this picture. */
      points: Record<string, Record<string, [number, number, boolean]>>
    }
  | { type: 'alive'; key: WorldKey; frames: number; tick: number }
  | { type: 'progress'; key: WorldKey; tick: number }
  | { type: 'at'; key: WorldKey; request: number; tick: number }
  | { type: 'frame'; key: WorldKey; request: number; tick: number; still: WorldStill }
  | { type: 'error'; key: WorldKey; message: string }
  | { type: 'lost' }
  | { type: 'input'; key: WorldKey; mode: 'none' | 'enter' | 'direct' }
  | { type: 'report'; key: WorldKey; values: unknown }
