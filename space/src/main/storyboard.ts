import { nativeImage } from 'electron'
import type { SnapshotRenderer } from './snapshot'

/**
 * The storyboard of a scene preview (run_scene with preview: true): each
 * frame is drawn by the hidden snapshot window (never on the learner's
 * board), then the frames are laid out in a grid in one PNG.
 */

export interface StoryboardFrame {
  t: number
  label: string
  nodes: unknown[]
  overrides: Array<[string, unknown]>
  tips: unknown[]
  clocks?: Array<[string, unknown]>
}

export interface StoryboardInput {
  frames: StoryboardFrame[]
  rect: { x: number; y: number; width: number; height: number }
  view: { x: number; y: number; width: number; height: number }
  background: string
}

const CELL_LONG_EDGE = 520
const MAX_COLUMNS = 3
const GAP = 8
/** The label strip above each frame, in pixels. */
const LABEL = 22

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

export async function renderStoryboard(snapshots: SnapshotRenderer, input: StoryboardInput): Promise<{ png: Buffer; width: number; height: number; columns: number }> {
  const { rect } = input
  const scale = Math.min(2, CELL_LONG_EDGE / Math.max(1, rect.width, rect.height))
  const cellW = Math.max(1, Math.round(rect.width * scale))
  const cellH = Math.max(1, Math.round(rect.height * scale))
  // The label strip is part of each captured frame: the rect grows upward by LABEL px.
  const labelBoard = LABEL / scale
  const shotRect = { x: rect.x, y: rect.y - labelBoard, width: rect.width, height: rect.height + labelBoard }
  const shotH = cellH + LABEL
  const bitmaps: Buffer[] = []
  for (const [index, frame] of input.frames.entries()) {
    const shot = await snapshots.capture({
      nodes: [...frame.nodes, labelNode(`${index + 1}. ${frame.label}`, rect.x + 4 / scale, rect.y - labelBoard + 4 / scale, scale, index)],
      rect: shotRect,
      scale,
      width: cellW,
      height: shotH,
      outlines: [{ rect: input.view, color: 'rgba(160, 160, 168, 0.55)' }],
      background: input.background,
      playback: { overrides: frame.overrides, tips: frame.tips, clocks: frame.clocks }
    })
    bitmaps.push(nativeImage.createFromBuffer(shot.png).toBitmap())
  }
  const columns = Math.min(MAX_COLUMNS, Math.max(1, bitmaps.length))
  const rows = Math.ceil(bitmaps.length / columns)
  const width = columns * cellW + (columns - 1) * GAP
  const height = rows * shotH + (rows - 1) * GAP
  // BGRA bitmap; the gaps stay transparent black, drawn as a dark band.
  const out = Buffer.alloc(width * height * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  bitmaps.forEach((bitmap, index) => {
    const ox = (index % columns) * (cellW + GAP)
    const oy = Math.floor(index / columns) * (shotH + GAP)
    const rowBytes = cellW * 4
    for (let y = 0; y < shotH; y++) {
      const from = y * rowBytes
      if (from + rowBytes > bitmap.length) break
      bitmap.copy(out, ((oy + y) * width + ox) * 4, from, from + rowBytes)
    }
  })
  const image = nativeImage.createFromBitmap(out, { width, height })
  return { png: image.toPNG(), width, height, columns }
}
