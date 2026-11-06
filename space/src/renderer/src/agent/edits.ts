import { isKnown, isOldLive, nodeRotation, SHAPE_WORDS, type BoardNode } from '@shared/board-format'
import { followsText } from '@shared/world-links'
import { liveParts } from '../live-pixels/registry'
import type { AgentToolName, BoardRect } from '@shared/space-api'
import type { BoardHandle } from '../board/Board'
import { ownBox } from '../board/rotation'
import { hasEnds } from '../board/shapes'
import { parentKey, ROOT, isFlowed } from '../board/scene'
import type { Region } from '../board/types'
import { liveReport, liveStatus, UNTRUSTED_NOTE } from '../live-pixels/registry'
import { runScene, sceneDraft, sceneFrames, sceneControl, sceneContext, sceneMemory, sceneRestore, type ScenePlace } from '../live/run'
import { isGroupId, type InkGroup, type InkGroupTracker } from './groups'
import { resolveTarget, sceneOf, type Scene } from './placement'

/**
 * The agent's board tools that run in the renderer against the live board:
 * live scenes (write_scene, preview_scene, play_scene), the one way agents
 * write, and getNodeInfo for get_item (the reads are in reads.ts).
 */

export interface EditContext {
  board: BoardHandle
  importAsset(src: string): Promise<string>
  /** The open board's ink groups, computed now. */
  groups(): InkGroup[]
  tracker: InkGroupTracker
  /** The open board's path. */
  path?: string
  /** The learning folder's root. */
  root?: string
}

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (region: Region | null | undefined): BoardRect | null =>
  region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null

// ---------- Helpers ----------

function scene(ctx: EditContext): Scene {
  return sceneOf(ctx.board, ctx.groups)
}

function requireNode(s: Scene, id: unknown, what = 'id'): BoardNode {
  if (typeof id !== 'string' || !id) throw new Error(`${what} is required.`)
  const node = s.index.byId.get(id)
  if (!node) throw new Error(`No item "${id}" on the open board. list_items() lists the ids.`)
  return node
}

/** The world origin of a parent's children (ROOT = board origin). */
function originOf(s: Scene, key: string): [number, number] {
  if (key === ROOT) return [0, 0]
  const box = s.layout.get(key)
  return box ? [box.ox, box.oy] : [0, 0]
}

// ---------- Read tools ----------

/** get_item as "info" for one node: every stored detail. */
export function getNodeInfo(s: Scene, id: unknown): unknown {
  if (isGroupId(id)) {
    const target = resolveTarget(s, id)
    if (target.kind === 'group') {
      const g = target.group
      return { id: g.id, kind: 'ink group', author: g.author, parent: g.parent || null, bounds: rect(g.bounds), strokes: g.strokes, seq: g.seq }
    }
  }
  const node = requireNode(s, id)
  const key = parentKey(node, s.index.byId)
  const box = s.layout.get(node.id)
  const origin = originOf(s, key)
  const info: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
    author: node.author,
    parent: key === ROOT ? null : key,
    bounds: rect(box),
    position_in_parent: box ? { x: r1(ownBox(box).x - origin[0]), y: r1(ownBox(box).y - origin[1]) } : null,
    placed_by: isFlowed(node, s.index.byId) ? 'flex layout of the parent' : 'x, y',
    z: node.z,
    children: (s.index.children.get(node.id) ?? []).map((child) => child.id),
    seq: node.seq,
    ...(typeof (node as { scene?: unknown }).scene === 'string' ? { scene: (node as { scene?: string }).scene } : {})
  }
  if (isKnown(node)) {
    if (node.locked) info.locked = true
    if (node.follows) info.follows = followsText(node.follows)
    if (node.kind === 'ink') Object.assign(info, { tool: node.tool, color: node.color, width: node.width, points: node.points.length })
    else if (node.kind === 'shape') {
      // The learner's shape: its size, or for an arrow or a line its start and end on the board.
      const [x, y] = box ? [box.ox, box.oy] : [node.x, node.y]
      const ends = hasEnds(node) ? { start: { x: r1(x), y: r1(y) }, end: { x: r1(x + node.w), y: r1(y + node.h) } } : { size: { w: node.w, h: node.h }, fill: node.fill }
      Object.assign(info, { shape: SHAPE_WORDS[node.shape], color: node.color, width: node.width, line: node.line, ...ends, ...(node.shape === 'arrow' ? { heads: node.heads } : {}) })
    } else info.style = node.style
    if (node.kind === 'text') info.text = node.text
    if (nodeRotation(node)) info.rotation = nodeRotation(node)
    if (node.kind === 'image') info.src = node.src
    if (node.kind === 'live') {
      const status = liveStatus(node.id)
      Object.assign(info, {
        size: { w: node.w, h: node.h },
        params: node.params,
        code_length: node.code.length,
        state: status ? (status.state === 'untrusted' ? 'paused' : status.state) : 'not shown',
        ...(status?.state === 'untrusted' ? { paused: UNTRUSTED_NOTE } : {}),
        ...(status?.error ? { error: status.error } : {}),
        input: status?.input ?? 'none',
        ...(liveReport(node.id) !== undefined ? { report: liveReport(node.id) } : {}),
        parts: liveParts(node.id) ?? [],
        pins: (node.pins ?? []).map((pin) => ({ id: pin.id, part: pin.part })),
        ...(isOldLive(node) ? { older_kind: node.mode } : {})
      })
    }
    if (node.kind === 'svg') {
      info.svg_ids = [...node.markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
      info.markup_length = node.markup.length
    }
  }
  return info
}


/** Run one board tool. Throws an Error with an agent-readable message. */
export async function runEditTool(ctx: EditContext, tool: AgentToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'sceneContext':
      return sceneContext(ctx.board, scene(ctx), ctx.path, (args.place as ScenePlace | undefined) ?? null)
    case 'runScene': {
      return runScene({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker, ...(ctx.root && ctx.path ? { where: { root: ctx.root, path: ctx.path } } : {}) }, args)
    }
    case 'sceneDraft':
      return sceneDraft({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'sceneFrames':
      return sceneFrames({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'sceneControl':
      return sceneControl({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'sceneRestore':
      return sceneRestore({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'sceneMemory':
      return sceneMemory({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
  }
}
