import { isFrame, isInk, isKnown, isLive, type BoardNode } from '@shared/board-format'
import type { AgentToolName, BoardRect } from '@shared/space-api'
import type { BoardHandle } from '../board/Board'
import { nodesToHtml } from '../board/html'
import { parentKey, ROOT, withDescendants, isFlowed } from '../board/scene'
import type { Region } from '../board/types'
import { liveReport, liveStatus, liveSummary } from '../live-pixels/registry'
import { runScene, previewScene, sceneControl, sceneContext } from '../live/run'
import { isGroupId, type InkGroup, type InkGroupTracker } from './groups'
import { resolveTarget, sceneOf, type Scene } from './placement'

/**
 * The agent's board tools that run in the renderer against the live board:
 * the reads (get_tree, get_node_info, get_html) and live scenes (run_scene,
 * scene_control), the one way agents write.
 */

export interface EditContext {
  board: BoardHandle
  importAsset(src: string): Promise<string>
  /** The open board's ink groups, computed now. */
  groups(): InkGroup[]
  tracker: InkGroupTracker
  /** The open board's path. */
  path?: string
}

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (region: Region | null | undefined): BoardRect | null =>
  region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null

// ---------- Helpers ----------

function scene(ctx: EditContext): Scene {
  return sceneOf(ctx.board, ctx.groups)
}

function requireNode(s: Scene, id: unknown, what = 'node_id'): BoardNode {
  if (typeof id !== 'string' || !id) throw new Error(`${what} is required.`)
  const node = s.index.byId.get(id)
  if (!node) throw new Error(`No node "${id}" on the open board. Call get_tree to see the node ids.`)
  return node
}

/** The world origin of a parent's children (ROOT = board origin). */
function originOf(s: Scene, key: string): [number, number] {
  if (key === ROOT) return [0, 0]
  const box = s.layout.get(key)
  return box ? [box.ox, box.oy] : [0, 0]
}

// ---------- Read tools ----------

function nodeLine(s: Scene, node: BoardNode): string {
  const box = s.layout.get(node.id)
  const where = box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : '(no layout)'
  const name = typeof node.name === 'string' && node.name ? ` "${node.name}"` : ''
  let extra = ''
  if (node.kind === 'text' && typeof node.text === 'string') {
    const text = node.text.replace(/\s+/g, ' ')
    extra = `  “${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`
  }
  if (isKnown(node) && node.kind === 'frame' && node.style.display === 'flex') extra = `  flex ${node.style.flexDirection ?? 'row'}`
  if (isLive(node)) extra = `  ${liveSummary(node)}`
  const author = isKnown(node) && node.author === 'learner' ? '  (learner)' : ''
  return `${node.kind}${name} ${node.id}  ${where}${extra}${author}`
}

function getTree(s: Scene, args: Record<string, unknown>): string {
  const depth = Math.max(1, Math.min(10, typeof args.depth === 'number' ? Math.floor(args.depth) : 3))
  const lines: string[] = []
  const inkGroups = (key: string, indent: string): void => {
    for (const group of s.groups) {
      if (group.parent !== key) continue
      const b = group.bounds
      const count = `${group.strokes.length} stroke${group.strokes.length === 1 ? '' : 's'}`
      lines.push(`${indent}ink group ${group.id}  ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}  ${count}  (${group.author})`)
    }
  }
  const walk = (key: string, level: number, indent: string): void => {
    for (const node of s.index.children.get(key) ?? []) {
      if (isInk(node)) continue
      lines.push(indent + nodeLine(s, node))
      if (isLive(node)) inkGroups(node.id, `${indent}  `)
      if (isFrame(node)) {
        if (level < depth) {
          walk(node.id, level + 1, `${indent}  `)
          inkGroups(node.id, `${indent}  `)
        } else {
          const count = withDescendants([node.id], s.index).size - 1
          if (count) lines.push(`${indent}  … ${count} node(s) below (raise depth)`)
        }
      }
    }
  }
  if (args.node_id !== undefined) {
    const node = requireNode(s, args.node_id)
    lines.push(nodeLine(s, node))
    if (isFrame(node) && depth > 1) {
      walk(node.id, 2, '  ')
      inkGroups(node.id, '  ')
    }
    if (isLive(node)) inkGroups(node.id, '  ')
  } else {
    lines.push(`board: ${s.nodes.length} node(s); x,y w×h are world bounds in board points; ink shows as groups (g1, g2, …): use a group id like a node id`)
    walk(ROOT, 1, '')
    inkGroups(ROOT, '')
  }
  return lines.join('\n')
}

function getNodeInfo(s: Scene, args: Record<string, unknown>): unknown {
  if (isGroupId(args.node_id)) {
    const target = resolveTarget(s, args.node_id)
    if (target.kind === 'group') {
      const g = target.group
      return { id: g.id, kind: 'ink group', author: g.author, parent: g.parent || null, bounds: rect(g.bounds), strokes: g.strokes, seq: g.seq }
    }
  }
  const node = requireNode(s, args.node_id)
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
    position_in_parent: box ? { x: r1(box.x - origin[0]), y: r1(box.y - origin[1]) } : null,
    placed_by: isFlowed(node, s.index.byId) ? 'flex layout of the parent' : 'x, y',
    z: node.z,
    children: (s.index.children.get(node.id) ?? []).map((child) => child.id),
    seq: node.seq,
    ...(typeof (node as { scene?: unknown }).scene === 'string' ? { scene: (node as { scene?: string }).scene } : {})
  }
  if (isKnown(node)) {
    if (node.locked) info.locked = true
    if (node.kind === 'ink') Object.assign(info, { tool: node.tool, color: node.color, width: node.width, points: node.points.length })
    else info.style = node.style
    if (node.kind === 'text') info.text = node.text
    if (node.kind === 'image') info.src = node.src
    if (node.kind === 'live') {
      const status = liveStatus(node.id)
      Object.assign(info, {
        mode: node.mode,
        size: { w: node.w, h: node.h },
        params: node.params,
        code_length: node.code.length,
        state: status ? status.state : 'not shown',
        ...(status?.error ? { error: status.error } : {}),
        ...(node.mode === 'program' ? { input: status?.input ?? 'none' } : {}),
        ...(liveReport(node.id) !== undefined ? { report: liveReport(node.id) } : {})
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
    case 'getTree':
      return getTree(scene(ctx), args)
    case 'getNodeInfo':
      return getNodeInfo(scene(ctx), args)
    case 'getHtml': {
      const s = scene(ctx)
      const node = requireNode(s, args.node_id)
      return nodesToHtml(node.id, s.index, args.include_ids !== false)
    }
    case 'sceneContext':
      return sceneContext(ctx.board, scene(ctx), ctx.path)
    case 'runScene': {
      return runScene({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    }
    case 'previewScene':
      return previewScene({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'sceneControl':
      return sceneControl({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
  }
}
