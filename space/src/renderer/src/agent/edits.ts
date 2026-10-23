import { isContent, isFrame, isInk, isKnown, renderableStyle, STYLE_KEYS, type BoardNode, type ContentNode, type NodeStyle } from '@shared/board-format'
import type { AgentRef, AgentToolName, BoardRect } from '@shared/space-api'
import type { BoardHandle, PresenceEntry } from '../board/Board'
import { draftsToNodes, htmlToDrafts, Ignored, nodesToHtml, walkDrafts, type Draft } from '../board/html'
import { ancestorIds, buildIndex, copySubtrees, isFlowed, parentKey, removeNodes, ROOT, topLevelOf, withDescendants, zAbove, type SceneIndex } from '../board/scene'
import type { LayoutBox, Region } from '../board/types'

/**
 * The agent's board tools (write_html, get_tree, update_styles, …), run in
 * the renderer against the live board. Every write is one undo step for the
 * learner (BoardHandle.agentCommit) and marks agent presence on the
 * top-level nodes it touched.
 */

export interface EditContext {
  board: BoardHandle
  agent: AgentRef
  importAsset(src: string): Promise<string>
  presence: AgentPresence
}

/** Space kept around agent material when it is placed automatically (board points). */
const PLACE_GAP = 48
/** Height assumed for a new frame whose height follows its content. */
const ASSUMED_HEIGHT = 360
const PRESENCE_MS = 20_000

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (region: Region | null | undefined): BoardRect | null =>
  region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null

// ---------- Presence ----------

/** Which agent is working on which top-level node. Shown as an outline with the client name. */
export class AgentPresence {
  private entries = new Map<string, { sessionId: string; client: string; last: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private board: BoardHandle | null = null

  attach(board: BoardHandle | null): void {
    if (board === this.board) return
    this.board = board
    this.push()
  }

  mark(agent: AgentRef, ids: Iterable<string>): void {
    const now = Date.now()
    for (const id of ids) this.entries.set(id, { sessionId: agent.sessionId, client: agent.client, last: now })
    this.push()
    if (!this.timer) this.timer = setInterval(() => this.expire(), 1000)
  }

  finish(sessionId: string, ids?: readonly string[]): string[] {
    const cleared: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.sessionId !== sessionId || (ids && !ids.includes(id))) continue
      this.entries.delete(id)
      cleared.push(id)
    }
    this.push()
    return cleared
  }

  private expire(): void {
    const now = Date.now()
    let changed = false
    for (const [id, entry] of this.entries) {
      if (now - entry.last > PRESENCE_MS) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.push()
    if (!this.entries.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private push(): void {
    const list: PresenceEntry[] = [...this.entries].map(([id, entry]) => ({ id, label: entry.client }))
    this.board?.setPresence(list)
  }
}

// ---------- Helpers ----------

interface Scene {
  nodes: readonly BoardNode[]
  index: SceneIndex
  layout: ReadonlyMap<string, LayoutBox>
}

function scene(board: BoardHandle): Scene {
  const state = board.liveState()
  return { nodes: state.nodes, index: buildIndex(state.nodes), layout: state.layout() }
}

function requireNode(s: Scene, id: unknown, what = 'node_id'): BoardNode {
  if (typeof id !== 'string' || !id) throw new Error(`${what} is required.`)
  const node = s.index.byId.get(id)
  if (!node) throw new Error(`No node "${id}" on the open board. Call get_tree to see the node ids.`)
  return node
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error(`${what} must be a list of node ids.`)
  return value as string[]
}

/** The world origin of a parent's children (ROOT = board origin). */
function originOf(s: Scene, key: string): [number, number] {
  if (key === ROOT) return [0, 0]
  const box = s.layout.get(key)
  return box ? [box.ox, box.oy] : [0, 0]
}

/** The top-level ancestors of some nodes (for presence). */
function topLevels(s: Scene, ids: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const node = s.index.byId.get(id)
    if (node && !isInk(topLevelOf(node, s.index.byId))) out.add(topLevelOf(node, s.index.byId).id)
  }
  return [...out]
}

const UNITLESS = new Set(['opacity', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight'])
const POSITION_KEYS = new Set(['x', 'y', 'left', 'top', 'right', 'bottom', 'position', 'transform'])

/** Normalize an agent style object: camelCase keys, numbers to px, whitelist. */
function normalizeStyles(input: unknown, ignored: Set<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (!input || typeof input !== 'object') return out
  const allowed = new Set<string>(STYLE_KEYS)
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.includes('-') ? rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : rawKey
    if (POSITION_KEYS.has(key)) {
      ignored.add(`${rawKey} (positions go through move_nodes)`)
      continue
    }
    if (!allowed.has(key)) {
      ignored.add(rawKey)
      continue
    }
    if (rawValue === null || rawValue === '') {
      out[key] = null
      continue
    }
    const value = typeof rawValue === 'number' ? (UNITLESS.has(key) ? String(rawValue) : `${rawValue}px`) : typeof rawValue === 'string' ? rawValue.trim() : null
    if (value === null) {
      ignored.add(rawKey)
      continue
    }
    // The renderer's own filter decides (url(), unknown display values).
    if (renderableStyle({ [key]: value })[key as keyof ReturnType<typeof renderableStyle>] === undefined) {
      ignored.add(`${rawKey}: ${value}`)
      continue
    }
    out[key] = value
  }
  return out
}

function applyStyles(style: NodeStyle, changes: Record<string, string | null>): NodeStyle {
  const next: NodeStyle = { ...style }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

// ---------- Placement ----------

function overlaps(a: Region, b: Region, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
}

/** Boxes agent material must not cover: top-level content and all ink. */
function obstacles(s: Scene, skip: ReadonlySet<string> = new Set()): Region[] {
  const out: Region[] = []
  for (const node of s.index.children.get(ROOT) ?? []) {
    if (skip.has(node.id)) continue
    const box = s.layout.get(node.id)
    if (box) out.push(box)
  }
  for (const node of s.index.byId.values()) {
    if (!isInk(node) || skip.has(node.id) || ancestorIds(node, s.index.byId).some((id) => skip.has(id))) continue
    const box = s.layout.get(node.id)
    if (box && !(s.index.children.get(ROOT) ?? []).some((top) => top.id === node.id)) out.push(box)
  }
  return out
}

/** Margin kept inside the learner's view when a spot must be visible (board points). */
const VIEW_MARGIN = 16

function inside(box: Region, view: Region): boolean {
  return box.x >= view.x && box.y >= view.y && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height
}

/**
 * The best empty spot for a box of `size` near `anchor`: right of it, then
 * below, then left, then above, moving outward, with PLACE_GAP to everything
 * in `blocked`. Spots fully inside `view` (the learner's viewport) win; only
 * when none fits does the box go outside the view (visible: false).
 */
export function findSpot(
  size: { width: number; height: number },
  anchor: Region,
  blocked: readonly Region[],
  view?: Region
): { x: number; y: number; visible: boolean } {
  const free = (x: number, y: number): boolean => !blocked.some((box) => overlaps({ x, y, ...size }, box, PLACE_GAP))
  const right = anchor.x + anchor.width + PLACE_GAP
  const below = anchor.y + anchor.height + PLACE_GAP
  const left = anchor.x - size.width - PLACE_GAP
  const above = anchor.y - size.height - PLACE_GAP
  const ring = (step: number): [number, number][] => [
    [right + step, anchor.y],
    [right, anchor.y + step],
    [anchor.x, below + step],
    [left - step, anchor.y],
    [right, anchor.y - step],
    [anchor.x + step, below],
    [anchor.x, above - step]
  ]
  const shown = view
    ? { x: view.x + VIEW_MARGIN, y: view.y + VIEW_MARGIN, width: view.width - VIEW_MARGIN * 2, height: view.height - VIEW_MARGIN * 2 }
    : null
  const isVisible = (x: number, y: number): boolean => !!shown && inside({ x, y, ...size }, shown)
  if (shown && size.width <= shown.width && size.height <= shown.height) {
    // 1. The usual spots around the anchor, kept only when fully in view.
    for (let step = 0; step < 60; step++) {
      for (const [x, y] of ring(step * 64)) if (isVisible(x, y) && free(x, y)) return { x: Math.round(x), y: Math.round(y), visible: true }
    }
    // 2. Any free spot in view, nearest to the anchor first.
    const spots: [number, number, number][] = []
    const cx = anchor.x + anchor.width / 2
    const cy = anchor.y + anchor.height / 2
    for (let x = shown.x; x + size.width <= shown.x + shown.width; x += 24) {
      for (let y = shown.y; y + size.height <= shown.y + shown.height; y += 24) {
        spots.push([x, y, Math.hypot(x + size.width / 2 - cx, y + size.height / 2 - cy)])
      }
    }
    spots.sort((a, b) => a[2] - b[2])
    for (const [x, y] of spots) if (free(x, y)) return { x: Math.round(x), y: Math.round(y), visible: true }
  }
  // 3. Outside the view.
  for (let step = 0; step < 60; step++) {
    for (const [x, y] of ring(step * 64)) if (free(x, y)) return { x: Math.round(x), y: Math.round(y), visible: isVisible(x, y) }
  }
  return { x: Math.round(right), y: Math.round(anchor.y), visible: isVisible(right, anchor.y) }
}

/** The learner's viewport in board points. */
function viewOf(board: BoardHandle): Region {
  const state = board.liveState()
  const width = state.viewport[0] / state.camera.zoom
  const height = state.viewport[1] / state.camera.zoom
  return { x: state.camera.center[0] - width / 2, y: state.camera.center[1] - height / 2, width, height }
}

/** Where agent material goes by default: beside `near`, else beside the learner's latest ink, else the view centre. */
function anchorFor(s: Scene, board: BoardHandle, near: unknown): Region {
  if (typeof near === 'string' && near) {
    const node = requireNode(s, near, 'near')
    const box = s.layout.get(node.id)
    if (box) return box
  }
  let latest: BoardNode | null = null
  for (const node of s.nodes) if (isInk(node) && node.author === 'learner' && (!latest || node.seq > latest.seq)) latest = node
  const state = board.liveState()
  const viewW = state.viewport[0] / state.camera.zoom
  const viewH = state.viewport[1] / state.camera.zoom
  const view = { x: state.camera.center[0] - viewW / 2, y: state.camera.center[1] - viewH / 2, width: viewW, height: viewH }
  const latestBox = latest ? s.layout.get(latest.id) : undefined
  if (latestBox && overlaps(latestBox, view, 0)) {
    // The learner's work near the latest stroke: its top-level frame when it is inside one.
    const top = latest ? topLevelOf(latest, s.index.byId) : null
    return (top && s.layout.get(top.id)) ?? latestBox
  }
  return { x: state.camera.center[0] - 1, y: state.camera.center[1] - 1, width: 2, height: 2 }
}

function sizeOf(style: NodeStyle, fallback: { width: number; height: number }): { width: number; height: number } {
  const px = (value: string | undefined): number | null => (value && /^-?[\d.]+px$/.test(value.trim()) ? parseFloat(value) : null)
  return { width: px(style.width) ?? fallback.width, height: px(style.height) ?? fallback.height }
}

// ---------- z order ----------

/** A z that puts a node at `index` among `siblings` (sorted by z, the node itself excluded). Renumbers when there is no room. */
function zAt(siblings: BoardNode[], index: number, nodes: Map<string, BoardNode>): number {
  const at = Math.max(0, Math.min(siblings.length, index))
  const zOf = (node: BoardNode): number => (typeof node.z === 'number' ? node.z : 0)
  const before = at > 0 ? zOf(siblings[at - 1]) : null
  const after = at < siblings.length ? zOf(siblings[at]) : null
  if (before === null && after === null) return 1
  if (before === null) return (after as number) - 1
  if (after === null) return before + 1
  const mid = (before + after) / 2
  if (mid > before && mid < after) return mid
  // No room: renumber the siblings 1, 2, … and leave a slot at `at`.
  siblings.forEach((sibling, i) => nodes.set(sibling.id, { ...(nodes.get(sibling.id) ?? sibling), z: i < at ? i + 1 : i + 2 } as BoardNode))
  return at + 1
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
  const author = isKnown(node) && node.author === 'learner' ? '  (learner)' : ''
  return `${node.kind}${name} ${node.id}  ${where}${extra}${author}`
}

function getTree(s: Scene, args: Record<string, unknown>): string {
  const depth = Math.max(1, Math.min(10, typeof args.depth === 'number' ? Math.floor(args.depth) : 3))
  const lines: string[] = []
  const inkGroups = (key: string, indent: string): void => {
    const ink = (s.index.children.get(key) ?? []).filter(isInk)
    for (const author of ['learner', 'agent'] as const) {
      const group = ink.filter((stroke) => stroke.author === author)
      if (!group.length) continue
      const boxes = group.map((stroke) => s.layout.get(stroke.id)).filter((box): box is LayoutBox => !!box)
      const x = Math.min(...boxes.map((b) => b.x))
      const y = Math.min(...boxes.map((b) => b.y))
      const w = Math.max(...boxes.map((b) => b.x + b.width)) - x
      const h = Math.max(...boxes.map((b) => b.y + b.height)) - y
      const ids = group.length <= 5 ? `  [${group.map((stroke) => stroke.id).join(', ')}]` : ''
      lines.push(`${indent}ink ×${group.length} (${author})  ${boxes.length ? `${Math.round(x)},${Math.round(y)} ${Math.round(w)}×${Math.round(h)}` : ''}${ids}`)
    }
  }
  const walk = (key: string, level: number, indent: string): void => {
    for (const node of s.index.children.get(key) ?? []) {
      if (isInk(node)) continue
      lines.push(indent + nodeLine(s, node))
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
  } else {
    lines.push(`board: ${s.nodes.length} node(s); x,y w×h are world bounds in board points`)
    walk(ROOT, 1, '')
    inkGroups(ROOT, '')
  }
  return lines.join('\n')
}

function getNodeInfo(s: Scene, args: Record<string, unknown>): unknown {
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
    seq: node.seq
  }
  if (isKnown(node)) {
    if (node.locked) info.locked = true
    if (node.kind === 'ink') Object.assign(info, { tool: node.tool, color: node.color, width: node.width, points: node.points.length })
    else info.style = node.style
    if (node.kind === 'text') info.text = node.text
    if (node.kind === 'image') info.src = node.src
    if (node.kind === 'svg') {
      info.svg_ids = [...node.markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
      info.markup_length = node.markup.length
    }
  }
  return info
}

// ---------- Write tools ----------

const DEFAULT_FRAME_STYLE: NodeStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '24px',
  width: '480px',
  height: 'fit-content',
  background: 'var(--ls-card)',
  borderRadius: '12px',
  color: 'var(--ls-text)'
}

function createFrame(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const ignored = new Set<string>()
  const style = applyStyles(DEFAULT_FRAME_STYLE, normalizeStyles(args.style, ignored))
  const size = sizeOf(style, { width: 480, height: ASSUMED_HEIGHT })
  let x: number
  let y: number
  let placed: string
  const view = viewOf(ctx.board)
  let visible: boolean
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    x = args.x
    y = args.y
    placed = 'at the given x, y'
    visible = inside({ x, y, ...size }, view)
  } else {
    const anchor = anchorFor(s, ctx.board, args.near)
    ;({ x, y, visible } = findSpot(size, anchor, obstacles(s), view))
    placed = typeof args.near === 'string' ? `in empty space beside ${args.near}` : 'in empty space beside the learner’s latest work (or the view centre)'
  }
  const id = draftsToNodes([{ kind: 'frame', style, x, y, children: [], ...(typeof args.name === 'string' && args.name ? { name: args.name } : {}) }], {
    zStart: zAbove(s.index.children.get(ROOT) ?? []),
    canUse: () => false,
    author: 'agent'
  })
  ctx.board.agentCommit([...s.nodes, ...id.nodes])
  const frameId = id.roots[0]
  ctx.presence.mark(ctx.agent, [frameId])
  return {
    id: frameId,
    bounds: rect(ctx.board.liveState().bounds(frameId)),
    placed,
    visible,
    ...(visible ? {} : { note: 'No empty spot fits in the learner’s view, so the frame is outside it. Tell the learner where it is.' }),
    ...(ignored.size ? { ignored_styles: [...ignored] } : {})
  }
}

async function resolveImages(ctx: EditContext, drafts: Draft[], ignored: Ignored): Promise<Draft[]> {
  const failed = new Set<Draft>()
  const jobs: Draft[] = []
  walkDrafts(drafts, (draft) => {
    if (draft.kind === 'image') jobs.push(draft)
  })
  for (const draft of jobs) {
    try {
      draft.src = await ctx.importAsset(draft.src ?? '')
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      ignored.notes.add(`image ${draft.src}: ${message}`)
      failed.add(draft)
    }
  }
  const prune = (list: Draft[]): Draft[] => list.filter((draft) => !failed.has(draft)).map((draft) => ({ ...draft, children: prune(draft.children) }))
  return prune(drafts)
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function writeHtml(ctx: EditContext, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.html !== 'string' || !args.html.trim()) throw new Error('html is required.')
  const mode = args.mode === 'replace' ? 'replace' : args.mode === 'insert_children' || args.mode === undefined ? 'insert_children' : null
  if (!mode) throw new Error('mode must be "insert_children" or "replace".')
  const ignored = new Ignored()
  let drafts = htmlToDrafts(args.html, ignored)
  drafts = await resolveImages(ctx, drafts, ignored)
  if (!drafts.length) throw new Error(`Nothing to write: the HTML had no supported content.${ignored.summary() ? ` Ignored: ${JSON.stringify(ignored.summary())}` : ''}`)

  // Read the board after the downloads: the learner may have drawn meanwhile.
  const s = scene(ctx.board)
  const targetId = args.target_id
  const toRoot = targetId === 'root'
  const target = toRoot ? null : requireNode(s, targetId, 'target_id')
  let next: BoardNode[]
  let created: ReturnType<typeof draftsToNodes>
  /** Top-level nodes that were auto-placed outside the learner's view. */
  const hidden: string[] = []

  if (mode === 'insert_children') {
    if (target && !isFrame(target)) throw new Error(`target_id "${target.id}" is a ${target.kind}; insert_children needs a frame (or "root"). Use mode "replace" to replace it.`)
    const parent = target?.id
    created = draftsToNodes(drafts, {
      parent,
      zStart: zAbove(s.index.children.get(parent ?? ROOT) ?? []),
      canUse: (id) => !s.index.byId.has(id),
      author: 'agent'
    })
    next = [...s.nodes, ...created.nodes]
    if (toRoot) {
      // Top-level material without left/top is placed in empty space, one root after another.
      const blocked = obstacles(s)
      const anchor = anchorFor(s, ctx.board, args.near)
      const view = viewOf(ctx.board)
      next = next.map((node) => {
        if (!created.roots.includes(node.id) || !isContent(node)) return node
        const draft = drafts[created.roots.indexOf(node.id)]
        if (draft.x !== 0 || draft.y !== 0) return node
        const size = sizeOf(node.style, { width: 400, height: ASSUMED_HEIGHT })
        const spot = findSpot(size, anchor, blocked, view)
        if (!spot.visible) hidden.push(node.id)
        blocked.push({ x: spot.x, y: spot.y, ...size })
        return { ...node, x: spot.x, y: spot.y }
      })
    }
  } else {
    if (!target) throw new Error('replace needs a target_id of a node (not "root").')
    if (isInk(target)) throw new Error('Ink cannot be replaced with HTML. Use delete_nodes, or move_nodes.')
    const key = parentKey(target, s.index.byId)
    const replaced = withDescendants([target.id], s.index)
    created = draftsToNodes(drafts, {
      parent: key === ROOT ? undefined : key,
      zStart: 0,
      canUse: (id) => !s.index.byId.has(id) || replaced.has(id),
      author: 'agent'
    })
    const firstRoot = created.roots[0]
    const rootSet = new Set(created.roots)
    // The new roots take the target's place: its z, and its x, y unless the HTML positions them.
    created.nodes = created.nodes.map((node) => {
      if (!rootSet.has(node.id) || !isKnown(node)) return node
      const i = created.roots.indexOf(node.id)
      const draft = drafts[i]
      const keepPlace = draft.x === 0 && draft.y === 0
      return { ...node, z: (target.z as number) + i / (created.roots.length + 1), ...(keepPlace ? { x: target.x, y: target.y } : {}) } as BoardNode
    })
    // Ink inside the replaced subtree moves to the first new root when it is a frame, so the learner's notes stay.
    const newFirst = created.nodes.find((node) => node.id === firstRoot)
    const keepInk = newFirst && isFrame(newFirst)
    const kept: BoardNode[] = []
    for (const node of s.nodes) {
      if (!replaced.has(node.id)) {
        kept.push(node)
        continue
      }
      if (keepInk && isInk(node) && node.id !== target.id) {
        const origin = originOf(s, parentKey(node, s.index.byId))
        const targetBox = s.layout.get(target.id)
        const base: [number, number] = targetBox ? [targetBox.ox, targetBox.oy] : [0, 0]
        kept.push({ ...node, parent: firstRoot, x: node.x + origin[0] - base[0], y: node.y + origin[1] - base[1] })
      }
    }
    next = [...kept, ...created.nodes]
  }

  ctx.board.agentCommit(next)
  if (created.nodes.some((node) => node.kind === 'image')) {
    await settle(250)
    ctx.board.remeasure()
  }
  const state = ctx.board.liveState()
  const after = scene(ctx.board)
  ctx.presence.mark(ctx.agent, topLevels(after, [...created.roots, ...(target ? [target.id] : [])]))
  const bounds: Record<string, BoardRect | null> = {}
  for (const id of [...created.roots, ...Object.values(created.named)]) bounds[id] = rect(state.bounds(id))
  const summary = ignored.summary()
  return {
    created: created.roots,
    ...(Object.keys(created.named).length ? { named: created.named } : {}),
    node_count: created.nodes.length,
    bounds,
    ...(hidden.length ? { outside_view: hidden } : {}),
    ...(summary ? { ignored: summary } : {})
  }
}

function updateStyles(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.updates) || !args.updates.length) throw new Error('updates must be a non-empty list of {node_ids, styles}.')
  const ignored = new Set<string>()
  const changed = new Map<string, BoardNode>()
  for (const update of args.updates as Record<string, unknown>[]) {
    const ids = stringList(update?.node_ids, 'node_ids')
    const styles = normalizeStyles(update?.styles, ignored)
    for (const id of ids) {
      const node = changed.get(id) ?? requireNode(s, id)
      if (!isKnown(node)) throw new Error(`Node "${id}" is of an unknown kind and cannot be styled.`)
      if (isInk(node)) {
        // Ink takes a colour only.
        const color = styles.color ?? styles.backgroundColor
        if (color) changed.set(id, { ...node, color })
        for (const key of Object.keys(styles)) if (key !== 'color') ignored.add(`${key} (ink takes color only)`)
        continue
      }
      changed.set(id, { ...node, style: applyStyles((node as ContentNode).style, styles) })
    }
  }
  ctx.board.agentCommit(s.nodes.map((node) => changed.get(node.id) ?? node))
  ctx.presence.mark(ctx.agent, topLevels(s, changed.keys()))
  return { updated: [...changed.keys()], ...(ignored.size ? { ignored_styles: [...ignored] } : {}) }
}

function setText(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.updates) || !args.updates.length) throw new Error('updates must be a non-empty list of {node_id, text}.')
  const changed = new Map<string, BoardNode>()
  for (const update of args.updates as Record<string, unknown>[]) {
    const node = requireNode(s, update?.node_id)
    if (node.kind !== 'text' || !isKnown(node)) throw new Error(`Node "${node.id}" is a ${node.kind}, not text.`)
    if (typeof update.text !== 'string') throw new Error(`text for "${node.id}" must be a string.`)
    changed.set(node.id, { ...node, text: update.text } as BoardNode)
  }
  ctx.board.agentCommit(s.nodes.map((node) => changed.get(node.id) ?? node))
  ctx.presence.mark(ctx.agent, topLevels(s, changed.keys()))
  return { updated: [...changed.keys()] }
}

function moveNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.moves) || !args.moves.length) throw new Error('moves must be a non-empty list.')
  const work = new Map<string, BoardNode>(s.nodes.map((node) => [node.id, node]))
  const touched: string[] = []
  const sorted = (key: string, except: string): BoardNode[] =>
    [...work.values()]
      .filter((node) => isKnown(node) && node.id !== except && parentKey(node, work) === key)
      .sort((a, b) => (a.z as number) - (b.z as number))

  for (const move of args.moves as Record<string, unknown>[]) {
    const original = requireNode(s, move?.node_id)
    const node = work.get(original.id) as BoardNode
    if (!isKnown(node)) throw new Error(`Node "${node.id}" is of an unknown kind.`)
    if (node.locked) throw new Error(`Node "${node.id}" is locked.`)
    const box = s.layout.get(node.id)
    const key = parentKey(node, work)
    const flowed = isFlowed(node, work)
    touched.push(node.id)

    if (typeof move.x === 'number' && typeof move.y === 'number') {
      if (flowed) throw new Error(`"${node.id}" is placed by its flex parent; use parent_id/index or before/after to reorder it.`)
      const origin = originOf(s, key)
      const current = box ? [box.x - origin[0], box.y - origin[1]] : [node.x, node.y]
      work.set(node.id, { ...node, x: node.x + (move.x - current[0]), y: node.y + (move.y - current[1]) })
      continue
    }
    if (typeof move.dx === 'number' || typeof move.dy === 'number') {
      if (flowed) throw new Error(`"${node.id}" is placed by its flex parent; it cannot be shifted.`)
      work.set(node.id, { ...node, x: node.x + (Number(move.dx) || 0), y: node.y + (Number(move.dy) || 0) })
      continue
    }
    let newKey: string
    let index: number | null = null
    if (typeof move.before === 'string' || typeof move.after === 'string') {
      const siblingId = (move.before ?? move.after) as string
      const sibling = requireNode(s, siblingId, move.before ? 'before' : 'after')
      newKey = parentKey(sibling, work)
      const list = sorted(newKey, node.id)
      const at = list.findIndex((entry) => entry.id === sibling.id)
      index = move.before ? at : at + 1
    } else if (typeof move.parent_id === 'string') {
      newKey = move.parent_id === 'root' ? ROOT : requireNode(s, move.parent_id, 'parent_id').id
      if (newKey !== ROOT) {
        const parent = work.get(newKey) as BoardNode
        if (!isFrame(parent)) throw new Error(`parent_id "${newKey}" is a ${parent.kind}; only frames hold children.`)
        if (newKey === node.id || ancestorIds(parent, work).includes(node.id)) throw new Error(`"${node.id}" cannot move into itself.`)
      }
      index = typeof move.index === 'number' ? Math.floor(move.index) : null
    } else {
      throw new Error('Each move needs {node_id, x, y}, {node_id, dx, dy}, {node_id, parent_id, index?} or {node_id, before|after}.')
    }
    const list = sorted(newKey, node.id)
    const z = zAt(list, index ?? list.length, work)
    let moved: BoardNode = { ...node, z }
    if (newKey !== key) {
      // Keep the world position (it matters for free placement and for ink).
      const from = originOf(s, key)
      const to = originOf(s, newKey)
      const position = isInk(node)
        ? { x: node.x + from[0] - to[0], y: node.y + from[1] - to[1] }
        : box
          ? { x: r1(box.x - to[0]), y: r1(box.y - to[1]) }
          : { x: node.x, y: node.y }
      moved = { ...moved, ...position } as BoardNode
      if (newKey === ROOT) delete (moved as { parent?: string }).parent
      else (moved as { parent?: string }).parent = newKey
    }
    work.set(node.id, moved)
  }
  ctx.board.agentCommit(s.nodes.map((node) => work.get(node.id) ?? node))
  const after = scene(ctx.board)
  ctx.presence.mark(ctx.agent, topLevels(after, touched))
  return {
    moved: [...new Set(touched)].map((id) => {
      const node = after.index.byId.get(id)
      return { node_id: id, parent: node ? (parentKey(node, after.index.byId) || 'root') : null, bounds: rect(after.layout.get(id)) }
    })
  }
}

function duplicateNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const ids = stringList(args.node_ids, 'node_ids')
  for (const id of ids) requireNode(s, id)
  const copied = copySubtrees(ids, s.index, s.layout, { detach: false })
  const idMap = copied.idMap ?? new Map<string, string>()
  const reverse = new Map([...idMap].map(([from, to]) => [to, from]))
  const roots = new Set(copied.roots)
  const blocked = obstacles(s)
  const view = viewOf(ctx.board)
  const hidden: string[] = []
  const zNext = new Map<string, number>()
  const nodes = copied.nodes.map((node) => {
    if (!roots.has(node.id) || !isKnown(node)) return node
    const source = s.index.byId.get(reverse.get(node.id) ?? '') as BoardNode
    const key = parentKey(node, s.index.byId)
    if (isFlowed(node, s.index.byId)) {
      // Right after the original in the flex order.
      const siblings = (s.index.children.get(key) ?? []).filter((sibling) => sibling.id !== source.id)
      const at = (s.index.children.get(key) ?? []).findIndex((sibling) => sibling.id === source.id)
      const z = typeof source.z === 'number' ? source.z + 0.5 / (1 + (zNext.get(key) ?? 0)) : zAbove(siblings)
      zNext.set(key, (zNext.get(key) ?? 0) + 1)
      void at
      return { ...node, z } as BoardNode
    }
    const z = zNext.get(key) ?? zAbove(s.index.children.get(key) ?? [])
    zNext.set(key, z + 1)
    if (key === ROOT) {
      const box = s.layout.get(source.id)
      if (box) {
        const spot = findSpot({ width: box.width, height: box.height }, box, blocked, view)
        if (!spot.visible) hidden.push(node.id)
        blocked.push({ x: spot.x, y: spot.y, width: box.width, height: box.height })
        return { ...node, z, x: node.x + (spot.x - box.x), y: node.y + (spot.y - box.y) } as BoardNode
      }
    }
    return { ...node, z, x: node.x + 20, y: node.y + 20 } as BoardNode
  })
  ctx.board.agentCommit([...s.nodes, ...nodes])
  const after = scene(ctx.board)
  ctx.presence.mark(ctx.agent, topLevels(after, copied.roots))
  const top: Record<string, string> = {}
  for (const id of ids) if (idMap.has(id)) top[id] = idMap.get(id) as string
  const descendants: Record<string, string> = {}
  for (const [from, to] of idMap) if (!ids.includes(from)) descendants[from] = to
  return {
    duplicates: top,
    ...(Object.keys(descendants).length ? { descendant_ids: descendants } : {}),
    bounds: Object.fromEntries(copied.roots.map((id) => [id, rect(after.layout.get(id))])),
    ...(hidden.length ? { outside_view: hidden } : {})
  }
}

function deleteNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const ids = stringList(args.node_ids, 'node_ids')
  for (const id of ids) requireNode(s, id)
  const next = removeNodes(s.nodes, ids, s.index)
  const left = new Set(next.map((node) => node.id))
  const removed = s.nodes.filter((node) => !left.has(node.id)).map((node) => ({ id: node.id, kind: node.kind, author: node.author }))
  const locked = ids.filter((id) => left.has(id))
  const tops = topLevels(s, ids).filter((id) => left.has(id))
  ctx.board.agentCommit(next)
  if (tops.length) ctx.presence.mark(ctx.agent, tops)
  return { removed, ...(locked.length ? { not_removed_locked: locked } : {}) }
}

/** Run one board tool. Throws an Error with an agent-readable message. */
export async function runEditTool(ctx: EditContext, tool: AgentToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'getTree':
      return getTree(scene(ctx.board), args)
    case 'getNodeInfo':
      return getNodeInfo(scene(ctx.board), args)
    case 'getHtml': {
      const s = scene(ctx.board)
      const node = requireNode(s, args.node_id)
      return nodesToHtml(node.id, s.index, args.include_ids !== false)
    }
    case 'createFrame':
      return createFrame(ctx, scene(ctx.board), args)
    case 'writeHtml':
      return writeHtml(ctx, args)
    case 'updateStyles':
      return updateStyles(ctx, scene(ctx.board), args)
    case 'setText':
      return setText(ctx, scene(ctx.board), args)
    case 'moveNodes':
      return moveNodes(ctx, scene(ctx.board), args)
    case 'duplicateNodes':
      return duplicateNodes(ctx, scene(ctx.board), args)
    case 'deleteNodes':
      return deleteNodes(ctx, scene(ctx.board), args)
    case 'finishWorking': {
      const ids = args.node_ids === undefined ? undefined : stringList(args.node_ids, 'node_ids')
      return { released: ctx.presence.finish(ctx.agent.sessionId, ids) }
    }
  }
}
