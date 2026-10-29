import type { SnapshotRenderer } from './snapshot'

/**
 * The frames of preview_scene in one PNG: the hidden snapshot window (never
 * the learner's board) draws all frames as a grid in one request and one
 * capture (one frame: one larger image). Live items come as stills made
 * before the capture (on the main window: renderer/live-pixels/stills.ts),
 * so the snapshot window only puts pictures together.
 */

export interface StoryboardFrame {
  t: number
  label: string
  /** The ink that only this frame shows (changing ink); the frames share the input's nodes. */
  inks: unknown[]
  overrides: Array<[string, unknown]>
  tips: unknown[]
  /** The learner's view at this frame's moment, and the parts of it that app UI covers while scenes play. */
  view: { x: number; y: number; width: number; height: number }
  covered: Array<{ x: number; y: number; width: number; height: number; by: string }>
}

/** The picture of a live item in one frame, and the tick it shows. */
export interface StoryboardStill {
  frame: number
  id: string
  url: string | null
  tick: number | null
}

export interface StoryboardInput {
  /** The nodes of all frames. */
  nodes: unknown[]
  frames: StoryboardFrame[]
  rect: { x: number; y: number; width: number; height: number }
  background: string
  stills?: StoryboardStill[]
}

export interface StoryboardOptions {
  /** The longest side of one frame in pixels (default 520). */
  cellLongEdge?: number
  /** At most this many pixels per board point (default 2). */
  maxScale?: number
}

const CELL_LONG_EDGE = 520
const MAX_COLUMNS = 3
const GAP = 8
/** The label strip above each frame, in pixels. */
const LABEL = 22

/** Image pixels per board point of each frame. */
export function storyboardScale(rect: { width: number; height: number }, options: StoryboardOptions = {}): number {
  return Math.min(options.maxScale ?? 2, (options.cellLongEdge ?? CELL_LONG_EDGE) / Math.max(1, rect.width, rect.height))
}

/** Board-coordinate text node for a frame's label, scaled to stay LABEL px tall in the image. */
function labelNode(text: string, x: number, y: number, scale: number, index: number): unknown {
  return {
    id: `storyboard-label-${index}`,
    kind: 'text',
    x,
    y,
    z: 1e9,
    author: 'agent',
    seq: 0,
    text: text.replace(/[*$]/g, ''),
    style: { fontSize: `${13 / scale}px`, color: 'var(--ls-muted)', whiteSpace: 'pre', lineHeight: '1.2' }
  }
}

export async function renderStoryboard(
  snapshots: SnapshotRenderer,
  input: StoryboardInput,
  options: StoryboardOptions = {}
): Promise<{ png: Buffer; width: number; height: number; columns: number; scale: number }> {
  const { rect } = input
  const scale = storyboardScale(rect, options)
  const cellW = Math.max(1, Math.round(rect.width * scale))
  const cellH = Math.max(1, Math.round(rect.height * scale))
  // The label strip is part of each captured frame: the rect grows upward by LABEL px.
  const labelBoard = LABEL / scale
  const shotRect = { x: rect.x, y: rect.y - labelBoard, width: rect.width, height: rect.height + labelBoard }
  const shotH = cellH + LABEL
  const stillsOf = new Map<number, Record<string, string>>()
  for (const still of input.stills ?? []) {
    if (!still.url) continue
    if (!stillsOf.has(still.frame)) stillsOf.set(still.frame, {})
    stillsOf.get(still.frame)![still.id] = still.url
  }
  const count = Math.max(1, input.frames.length)
  const columns = Math.min(MAX_COLUMNS, count)
  const rows = Math.ceil(count / columns)
  const width = columns * cellW + (columns - 1) * GAP
  const height = rows * shotH + (rows - 1) * GAP
  const shot = await snapshots.capture({
    nodes: input.nodes,
    rect: shotRect,
    scale,
    width,
    height,
    outlines: [],
    background: input.background,
    cells: {
      width: cellW,
      height: shotH,
      // The gaps between the frames (image data, not a design colour).
      gapColor: '#000000',
      markTop: LABEL,
      list: input.frames.map((frame, index) => ({
        left: (index % columns) * (cellW + GAP),
        top: Math.floor(index / columns) * (shotH + GAP),
        nodes: [...frame.inks, labelNode(`${index + 1}. ${frame.label}`, rect.x + 4 / scale, rect.y - labelBoard + 4 / scale, scale, index)],
        ...(stillsOf.has(index) ? { stills: stillsOf.get(index) } : {}),
        playback: { overrides: frame.overrides, tips: frame.tips },
        // Each frame marks the learner's view and its hidden parts at its own moment (the camera can move).
        marks: [
          { kind: 'view' as const, rect: frame.view, tag: "learner's view" },
          ...frame.covered.map(({ by, ...area }) => ({ kind: 'covered' as const, rect: area, tag: by }))
        ]
      }))
    }
  })
  return { png: shot.png, width, height, columns, scale }
}
