// The contract between the page (WorldSurface) and the world worker, over one
// MessagePort. See docs/one-world-architecture.md.
// Board values are board points. Pixels are device pixels of the surface.

import type { WorldTune } from './world-tune'

/** Ticks per second of item time: the grid of previews and stills. */
export const WORLD_TICK_HZ = 60

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

/** A point kept on a part: `local` in the space of the part's object. It shows in a picture's points as `pin:<id>`. */
export interface WorldPin {
  id: string
  part: string
  local: [number, number, number]
}

/** A pointer event for a world. x and y are board points. */
export interface WorldPointer {
  kind: 'down' | 'move' | 'up' | 'cancel' | 'wheel' | 'enter' | 'leave'
  x: number
  y: number
  /** As PointerEvent.buttons. */
  buttons: number
  /** 0..1. */
  pressure: number
  pointerType: string
  /** Wheel only: as WheelEvent. */
  deltaX?: number
  deltaY?: number
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

/** A stroke of ink for a world. points: [x, y, pressure] in board points. */
export interface WorldStroke {
  id: string
  points: Array<[number, number, number]>
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
  /** The world's pins at its start, so a replay keeps them. */
  pins?: WorldPin[]
}

/** One window of rendering, about one second. Per-picture values are for the pictures in this window. Null: no picture in it. */
export interface WorldStats {
  /** Length of the window. */
  seconds: number
  pictures: number
  picturesPerSecond: number
  /** Where gpuMs comes from. 'fence': wall time from flush to fence, which is not pure GPU time. */
  gpuSource: 'timer' | 'fence' | null
  gpuMsMedian: number | null
  gpuMsP95: number | null
  /** Wall time from flush to fence. */
  fenceMsMedian: number | null
  /** Wall time from the first render call of a picture to its fence. */
  pictureMsMedian: number | null
  /** Worker CPU time in the render calls of a picture, with the transfer of the bitmap. */
  cpuMsMedian: number | null
  /** World ticks per second, and worker CPU per second of the run: in the world's frame code, in the picture check, in the plan of reach and crops. */
  ticksPerSecond: number
  tickMsPerSecond: number
  checkMsPerSecond: number
  planMsPerSecond: number
  /** Per shown world: board points per reach, and the pixels of the scene and of the whole crop at the last render. */
  crops: Array<{ scale: number; reach: [number, number]; scene: [number, number]; crop: [number, number] }>
  /** Lowest share of full resolution over the shown worlds, 1 to 0.5. */
  resolution: number
  /** Output pixels rendered per picture, in millions. */
  megapixels: number | null
  /** Pixels of the bitmap sent per picture, in millions. */
  bitmapMegapixels: number | null
  drawCalls: number | null
  triangles: number | null
  /** renderer.render calls per picture. */
  passes: number | null
  programs: number
  textures: number
  geometries: number
  /** Shared render targets. */
  targets: number
  worldsAlive: number
  /** Worlds rendered per picture. */
  worldsRendered: number | null
  /** Worlds per picture that waited for their turn. */
  worldsWaited: number | null
}

export type PageToWorld =
  /** width and height: board element in CSS pixels. margin: overscan in CSS pixels per side. fileToken: this worker's right to read the folder. */
  | { type: 'init'; width: number; height: number; dpr: number; margin: number; tune?: WorldTune; fileToken?: string }
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
  /** While on, the worker sends one `stats` message per second. */
  | { type: 'stats'; on: boolean }
  /** While on, a picture waits only for the GPU: not for the page, not for a display frame. */
  | { type: 'uncapped'; on: boolean }
  /** Dev only (frameAt): while on, every picture is at full quality with every world in it, and a `settled` follows each frame. */
  | { type: 'exact'; on: boolean }
  /** A pointer event. Send it only while the world's last `subscribe` says pointer. */
  | { type: 'pointer'; key: WorldKey; event: WorldPointer }
  /** What is at a board point. The answer is `picked` with the same request. */
  | { type: 'pick'; key: WorldKey; x: number; y: number; request: number }
  | { type: 'pin'; key: WorldKey; pin: WorldPin }
  | { type: 'unpin'; key: WorldKey; id: string }
  /** A stroke, new or changed (the same id replaces it). Send it only while `subscribe` says ink. */
  | { type: 'ink'; key: WorldKey; stroke: WorldStroke }
  | { type: 'inkgone'; key: WorldKey; id: string }

/** A still of one world, larger than its nominal rect when it needs to be. */
export interface WorldStill {
  blob: Blob | null
  /** Where the picture sits, in board points, from the nominal rect's top-left. It includes the world's `anchor` move. */
  x: number
  y: number
  w: number
  h: number
  /** The world's published points: [x, y, visible], with x and y from the nominal rect's top-left, as above, with the same move. */
  points?: Record<string, [number, number, boolean]>
}

export type WorldToPage =
  | { type: 'ready' }
  /** info: what the GPU holds and the renders per node, for checks. */
  | { type: 'pong'; n: number; running: string | null; info?: { geometries: number; textures: number; programs: number; targets: number; renders: Record<string, number> } }
  /**
   * The world that runs now, or null for the runtime. Sent only on a change, so that after a hang the last
   * one names the world at fault. No `key` field: this message is for the surface, not for one world.
   */
  | { type: 'running'; running: WorldKey | null }
  | { type: 'stats'; stats: WorldStats }
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
      /** Where the bitmap lies, in CSS pixels from the board's top-left corner at that camera. */
      box: { x: number; y: number; width: number; height: number }
      bitmap: ImageBitmap
      /** Board positions of published points by node, name: [x, y, visible], for exactly the state in this picture. */
      points: Record<string, Record<string, [number, number, boolean]>>
    }
  /** Exact frames only: after picture n, the item time (ms) that each listed world shows. A world that still draws is not listed. */
  | { type: 'settled'; n: number; times: Array<[node: string, generation: number, ms: number]> }
  | { type: 'alive'; key: WorldKey; frames: number; tick: number }
  | { type: 'progress'; key: WorldKey; tick: number }
  | { type: 'at'; key: WorldKey; request: number; tick: number }
  | { type: 'frame'; key: WorldKey; request: number; tick: number; still: WorldStill }
  | { type: 'error'; key: WorldKey; message: string }
  | { type: 'lost' }
  /** The worker ran the worlds with modules that it can hold, and asks for its planned end. No loss. */
  | { type: 'recycle' }
  | { type: 'input'; key: WorldKey; mode: 'none' | 'enter' | 'direct' }
  | { type: 'report'; key: WorldKey; values: unknown }
  /** A line of the world's console, for the agent. */
  | { type: 'log'; key: WorldKey; level: string; text: string }
  /** The worker loads files. Sent as loads start and end. It holds no number, because this realm runs world code: the size of a read comes from main. No `key`: a hang is a matter of the worker. */
  | { type: 'files' }
  /** The answer to `pick`. part: the nearest published ancestor. local: in the part's space. point: in world space. hit null: nothing there. */
  | { type: 'picked'; key: WorldKey; request: number; hit: { part: string | null; local: [number, number, number]; point: [number, number, number] } | null }
  /** The cursor the world asks for over itself, a CSS cursor. Empty: the board's own. Sent on a change. */
  | { type: 'cursor'; key: WorldKey; value: string }
  /** Which input the world's code listens to now. Sent on a change. */
  | { type: 'subscribe'; key: WorldKey; pointer: boolean; wheel: boolean; ink: boolean }
  /**
   * The world moved itself: board points from its placed rect, not saved. The worker already shows it in the next picture.
   * Keep sending the placed rect in `view`: a placement holds no anchor. dx and dy move selection and follows only.
   */
  | { type: 'anchor'; key: WorldKey; dx: number; dy: number }
