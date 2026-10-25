import { isContent, isFrame, isInk, isKnown, newItemId, renderableStyle, STYLE_KEYS, styleKey, type BoardNode, type ContentNode, type InkNode, type NodeStyle } from '@shared/board-format'
import { MAX_BOX_SIZE, MAX_COORD, MAX_HTML_CHARS, MAX_INK_LINES, MAX_INK_POINTS, MAX_STYLE_CHARS, MAX_TEXT_CHARS } from '@shared/limits'
import type { AgentRef, AgentToolName, BoardRect } from '@shared/space-api'
import type { BoardHandle, PresenceEntry } from '../board/Board'
import { clampZoom, overlapShare, unionRegions } from '../board/geometry'
import { draftsToNodes, htmlToDrafts, Ignored, nodesToHtml, walkDrafts, type Draft } from '../board/html'
import { ancestorIds, copySubtrees, isFlowed, normalizeInk, parentKey, removeNodes, ROOT, topLevelOf, withDescendants, zAbove } from '../board/scene'
import type { Point, Region } from '../board/types'
import { runScene, sceneContext } from '../live/run'
import { isGroupId, type InkGroup, type InkGroupTracker } from './groups'
import { humanize, inkPointBudget, shapeLines, SHAPES, svgPathPolylines, type ArrowSide, type Shape } from './ink'
import {
  anchorFor,
  ASSUMED_HEIGHT,
  expandIds,
  findSpace,
  findSpot,
  groupSubject,
  inside,
  nodeSubject,
  obstacles,
  overlapReport,
  parsePlace,
  placeRelative,
  resolveTarget,
  sceneOf,
  sizeOf,
  viewOf,
  type PlaceSpec,
  type Placed,
  type Scene,
  type Subject
} from './placement'

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
  /** The open board's ink groups, computed now. */
  groups(): InkGroup[]
  tracker: InkGroupTracker
}

const PRESENCE_MS = 20_000

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (region: Region | null | undefined): BoardRect | null =>
  region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null


/** A board coordinate or offset from an agent: finite and within ±MAX_COORD. */
function coordArg(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORD) {
    throw new Error(`${what} must be a finite number within ±${MAX_COORD} board points.`)
  }
  return value
}

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

function scene(ctx: EditContext): Scene {
  return sceneOf(ctx.board, ctx.groups)
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
    const key = styleKey(rawKey)
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
    const value =
      typeof rawValue === 'number' && Number.isFinite(rawValue) && Math.abs(rawValue) <= MAX_COORD
        ? UNITLESS.has(key) ? String(rawValue) : `${rawValue}px`
        : typeof rawValue === 'string' && rawValue.length <= MAX_STYLE_CHARS ? rawValue.trim() : null
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

// ---------- Placement helpers ----------

/** The world box a `place` spec points at. */
function placeTarget(s: Scene, spec: PlaceSpec): Region {
  const target = resolveTarget(s, spec.target, `place.${spec.side}`)
  if (!target.box) throw new Error(`"${spec.target}" has no layout (it may be hidden), so nothing can be placed relative to it.`)
  return target.box
}

/** Overlaps of top-level ancestors and given nodes, read after a commit. */
function overlapsOf(ctx: EditContext, ids: Iterable<string>): ReturnType<typeof overlapReport> {
  const after = scene(ctx)
  return overlapReport(after, [...new Set(ids)].map((id) => nodeSubject(after, id)))
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
  const place = parsePlace(args.place)
  if (place) {
    ;({ x, y, visible, placed } = placeRelative(place, placeTarget(s, place), size, obstacles(s), view))
  } else if (typeof args.x === 'number' && typeof args.y === 'number') {
    x = coordArg(args.x, 'x')
    y = coordArg(args.y, 'y')
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
  // The spot was chosen with an estimated size; report what the measured frame shows.
  const measured = ctx.board.liveState().bounds(frameId)
  if (measured) visible = inside(measured, viewOf(ctx.board))
  return {
    id: frameId,
    bounds: rect(measured),
    placed,
    visible,
    ...(visible ? {} : { note: 'The frame is outside the learner’s view. Tell the learner where it is, or use focus.' }),
    ...overlapsOf(ctx, [frameId]),
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

/**
 * After layout: an auto-placed root that is not fully in the learner's view
 * moves to a free spot that fits its measured size inside the view, with the
 * same anchor (or `place` side preference) and no-overlap rules. When no such
 * spot exists, it stays where it is (the result then says visible: false).
 * The move amends the write's own undo step.
 */
function refitAfterLayout(
  ctx: EditContext,
  ids: readonly string[],
  place: { spec: PlaceSpec; box: Region } | null,
  anchor: Region,
  placements: Map<string, string>
): void {
  const s = scene(ctx)
  const view = viewOf(ctx.board)
  const blocked = obstacles(s, new Set(ids))
  const misfits: { id: string; box: Region }[] = []
  for (const id of ids) {
    const box = s.layout.get(id)
    if (!box) continue
    if (inside(box, view)) blocked.push(box)
    else misfits.push({ id, box })
  }
  if (!misfits.length) return
  const shifts = new Map<string, [number, number]>()
  for (const { id, box } of misfits) {
    const size = { width: box.width, height: box.height }
    const spot = place ? placeRelative(place.spec, place.box, size, blocked, view, true) : findSpot(size, anchor, blocked, view)
    if (!inside({ x: spot.x, y: spot.y, ...size }, view)) {
      blocked.push(box)
      continue
    }
    shifts.set(id, [spot.x - box.x, spot.y - box.y])
    blocked.push({ x: spot.x, y: spot.y, ...size })
    const measured = `${Math.round(size.width)}×${Math.round(size.height)}`
    placements.set(id, `${'placed' in spot ? spot.placed : 'in empty space'}; moved after layout so its measured size (${measured}) fits in the learner’s view`)
  }
  if (!shifts.size) return
  const nodes = ctx.board.liveState().nodes.map((node) => {
    const shift = shifts.get(node.id)
    return shift && isContent(node) ? ({ ...node, x: r1(node.x + shift[0]), y: r1(node.y + shift[1]) } as BoardNode) : node
  })
  ctx.board.agentAmend(nodes)
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function writeHtml(ctx: EditContext, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.html !== 'string' || !args.html.trim()) throw new Error('html is required.')
  if (args.html.length > MAX_HTML_CHARS) throw new Error(`html is too long (over ${MAX_HTML_CHARS} characters). Write it in smaller parts.`)
  const mode = args.mode === 'replace' ? 'replace' : args.mode === 'insert_children' || args.mode === undefined ? 'insert_children' : null
  if (!mode) throw new Error('mode must be "insert_children" or "replace".')
  const ignored = new Ignored()
  let drafts = htmlToDrafts(args.html, ignored)
  drafts = await resolveImages(ctx, drafts, ignored)
  if (!drafts.length) throw new Error(`Nothing to write: the HTML had no supported content.${ignored.summary() ? ` Ignored: ${JSON.stringify(ignored.summary())}` : ''}`)

  // Read the board after the downloads: the learner may have drawn meanwhile.
  const s = scene(ctx)
  const targetId = args.target_id
  const toRoot = targetId === 'root'
  const target = toRoot ? null : requireNode(s, targetId, 'target_id')
  let next: BoardNode[]
  let created: ReturnType<typeof draftsToNodes>
  /** Top-level roots this write placed itself (no left/top in the HTML), in order. */
  const autoPlaced: string[] = []
  const placements = new Map<string, string>()
  const place = mode === 'insert_children' && toRoot ? parsePlace(args.place) : null
  const placeBox = place ? placeTarget(s, place) : null
  const anchor = anchorFor(s, ctx.board, args.near)

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
      // Top-level material without left/top is placed in empty space (or by `place`), one root after another.
      const blocked = obstacles(s)
      const view = viewOf(ctx.board)
      next = next.map((node) => {
        if (!created.roots.includes(node.id) || !isContent(node)) return node
        const draft = drafts[created.roots.indexOf(node.id)]
        if (!place && (draft.x !== 0 || draft.y !== 0)) return node
        // The size is an estimate before layout; refitAfterLayout corrects the spot with the measured size.
        const size = sizeOf(node.style, { width: 400, height: ASSUMED_HEIGHT })
        const spot: Placed | ReturnType<typeof findSpot> = place && placeBox ? placeRelative(place, placeBox, size, blocked, view) : findSpot(size, anchor, blocked, view)
        if ('placed' in spot && typeof spot.placed === 'string') placements.set(node.id, spot.placed)
        autoPlaced.push(node.id)
        blocked.push({ x: spot.x, y: spot.y, ...size })
        return { ...node, x: spot.x, y: spot.y }
      })
    }
  } else {
    if (!target) throw new Error('replace needs a target_id of a node (not "root").')
    if (isInk(target)) throw new Error('Ink cannot be replaced with HTML. Use delete_nodes, or move_nodes.')
    const key = parentKey(target, s.index.byId)
    const replaced = withDescendants([target.id], s.index)
    // The replacement keeps the target's identity: its first top-level node takes target_id's id, so
    // everything that names the target (focus, screenshots, place, presence) still finds it. It is
    // built first, so no other node in the HTML can claim that id.
    drafts = [{ ...drafts[0], wantedId: target.id }, ...drafts.slice(1)]
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
  if (autoPlaced.length) refitAfterLayout(ctx, autoPlaced, place && placeBox ? { spec: place, box: placeBox } : null, anchor, placements)
  const state = ctx.board.liveState()
  const after = scene(ctx)
  const touchedTops = topLevels(after, [...created.roots, ...(target ? [target.id] : [])])
  ctx.presence.mark(ctx.agent, touchedTops)
  // Visibility comes from the final measured bounds of every top-level node the write touched.
  const view = viewOf(ctx.board)
  const hidden = touchedTops.filter((id) => {
    const box = after.layout.get(id)
    return !box || !inside(box, view)
  })
  const bounds: Record<string, BoardRect | null> = {}
  for (const id of [...created.roots, ...Object.values(created.named)]) bounds[id] = rect(state.bounds(id))
  const summary = ignored.summary()
  return {
    created: created.roots,
    ...(target && mode === 'replace' && created.roots.length > 1
      ? { kept_id: `${target.id} is now the first of the ${created.roots.length} new top-level nodes; the others have new ids.` }
      : {}),
    ...(Object.keys(created.named).length ? { named: created.named } : {}),
    node_count: created.nodes.length,
    bounds,
    ...(placements.size ? { placed: [...placements].map(([id, words]) => `${id}: ${words}`) } : {}),
    visible: hidden.length === 0,
    ...(hidden.length
      ? {
          outside_view: hidden,
          note: 'Part of this material is outside the learner’s view (measured after layout). Use focus to show it, or tell the learner where it is.'
        }
      : {}),
    ...overlapReport(after, [...created.roots, ...touchedTops.filter((id) => !created.roots.includes(id))].map((id) => nodeSubject(after, id))),
    ...(summary ? { ignored: summary } : {})
  }
}

function updateStyles(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.updates) || !args.updates.length) throw new Error('updates must be a non-empty list of {node_ids, styles}.')
  const ignored = new Set<string>()
  const changed = new Map<string, BoardNode>()
  for (const update of args.updates as Record<string, unknown>[]) {
    const ids = expandIds(s, stringList(update?.node_ids, 'node_ids'))
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
  return { updated: [...changed.keys()], ...overlapsOf(ctx, topLevels(s, changed.keys())), ...(ignored.size ? { ignored_styles: [...ignored] } : {}) }
}

function setText(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.updates) || !args.updates.length) throw new Error('updates must be a non-empty list of {node_id, text}.')
  const changed = new Map<string, BoardNode>()
  for (const update of args.updates as Record<string, unknown>[]) {
    const node = requireNode(s, update?.node_id)
    if (node.kind !== 'text' || !isKnown(node)) throw new Error(`Node "${node.id}" is a ${node.kind}, not text.`)
    if (typeof update.text !== 'string') throw new Error(`text for "${node.id}" must be a string.`)
    if (update.text.length > MAX_TEXT_CHARS) throw new Error(`text for "${node.id}" is too long (over ${MAX_TEXT_CHARS} characters).`)
    changed.set(node.id, { ...node, text: update.text } as BoardNode)
  }
  ctx.board.agentCommit(s.nodes.map((node) => changed.get(node.id) ?? node))
  ctx.presence.mark(ctx.agent, topLevels(s, changed.keys()))
  return { updated: [...changed.keys()], ...overlapsOf(ctx, topLevels(s, changed.keys())) }
}

function moveNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  if (!Array.isArray(args.moves) || !args.moves.length) throw new Error('moves must be a non-empty list.')
  const work = new Map<string, BoardNode>(s.nodes.map((node) => [node.id, node]))
  const touched: string[] = []
  const movedGroups: string[] = []
  const placements: string[] = []
  const view = viewOf(ctx.board)
  const sorted = (key: string, except: string): BoardNode[] =>
    [...work.values()]
      .filter((node) => isKnown(node) && node.id !== except && parentKey(node, work) === key)
      .sort((a, b) => (a.z as number) - (b.z as number))
  const shift = (ids: readonly string[], delta: Point): void => {
    for (const id of ids) {
      const node = work.get(id)
      if (node && isKnown(node) && !node.locked) work.set(id, { ...node, x: node.x + delta[0], y: node.y + delta[1] } as BoardNode)
    }
  }

  // A group moved into a frame is its strokes moved one by one.
  const moves: Record<string, unknown>[] = []
  for (const move of args.moves as Record<string, unknown>[]) {
    if (isGroupId(move?.node_id) && typeof move.parent_id === 'string') {
      const target = resolveTarget(s, move.node_id)
      if (target.kind === 'group') {
        movedGroups.push(target.id)
        for (const id of target.group.strokes) moves.push({ ...move, node_id: id })
        continue
      }
    }
    moves.push(move)
  }

  for (const move of moves) {
    const place = parsePlace(move?.place)
    if (isGroupId(move?.node_id)) {
      const target = resolveTarget(s, move.node_id)
      if (target.kind === 'group') {
        const g = target.group
        let delta: Point
        if (place) {
          const spot = placeRelative(place, placeTarget(s, place), { width: g.bounds.width, height: g.bounds.height }, obstacles(s, new Set(g.strokes)), view)
          placements.push(`${g.id}: ${spot.placed}`)
          delta = [spot.x - g.bounds.x, spot.y - g.bounds.y]
        } else if (typeof move.x === 'number' && typeof move.y === 'number') {
          const origin = originOf(s, g.parent)
          delta = [coordArg(move.x, 'x') + origin[0] - g.bounds.x, coordArg(move.y, 'y') + origin[1] - g.bounds.y]
        } else if (typeof move.dx === 'number' || typeof move.dy === 'number') {
          delta = [move.dx === undefined ? 0 : coordArg(move.dx, 'dx'), move.dy === undefined ? 0 : coordArg(move.dy, 'dy')]
        } else {
          throw new Error(`An ink group moves with {node_id, place}, {node_id, x, y}, {node_id, dx, dy} or {node_id, parent_id}; "${g.id}" cannot be reordered with before/after.`)
        }
        shift(g.strokes, delta)
        touched.push(...g.strokes)
        movedGroups.push(g.id)
        continue
      }
    }
    const original = requireNode(s, move?.node_id)
    const node = work.get(original.id) as BoardNode
    if (!isKnown(node)) throw new Error(`Node "${node.id}" is of an unknown kind.`)
    if (node.locked) throw new Error(`Node "${node.id}" is locked.`)
    const box = s.layout.get(node.id)
    const key = parentKey(node, work)
    const flowed = isFlowed(node, work)
    touched.push(node.id)

    if (place) {
      if (flowed) throw new Error(`"${node.id}" is placed by its flex parent; move it to "root" first (parent_id) to place it freely.`)
      if (!box) throw new Error(`"${node.id}" has no layout, so it cannot be placed.`)
      const spot = placeRelative(place, placeTarget(s, place), { width: box.width, height: box.height }, obstacles(s, new Set([node.id])), view)
      placements.push(`${node.id}: ${spot.placed}`)
      shift([node.id], [spot.x - box.x, spot.y - box.y])
      continue
    }
    if (typeof move.x === 'number' && typeof move.y === 'number') {
      if (flowed) throw new Error(`"${node.id}" is placed by its flex parent; use parent_id/index or before/after to reorder it.`)
      const origin = originOf(s, key)
      const current = box ? [box.x - origin[0], box.y - origin[1]] : [node.x, node.y]
      work.set(node.id, { ...node, x: node.x + (coordArg(move.x, 'x') - current[0]), y: node.y + (coordArg(move.y, 'y') - current[1]) })
      continue
    }
    if (typeof move.dx === 'number' || typeof move.dy === 'number') {
      if (flowed) throw new Error(`"${node.id}" is placed by its flex parent; it cannot be shifted.`)
      work.set(node.id, { ...node, x: node.x + (move.dx === undefined ? 0 : coordArg(move.dx, 'dx')), y: node.y + (move.dy === undefined ? 0 : coordArg(move.dy, 'dy')) })
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
      throw new Error('Each move needs {node_id, place}, {node_id, x, y}, {node_id, dx, dy}, {node_id, parent_id, index?} or {node_id, before|after}.')
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
  const after = scene(ctx)
  ctx.presence.mark(ctx.agent, topLevels(after, touched))
  const groupIds = [...new Set(movedGroups)]
  const groupStrokes = new Set(groupIds.flatMap((id) => s.groupById.get(id)?.strokes ?? []))
  const nodeIds = [...new Set(touched)].filter((id) => !groupStrokes.has(id))
  const subjects: (Subject | null)[] = [
    ...nodeIds.map((id) => nodeSubject(after, id)),
    ...groupIds.map((id) => {
      const group = after.groupById.get(id)
      return group ? groupSubject(group) : null
    })
  ]
  return {
    moved: [
      ...nodeIds.map((id) => {
        const node = after.index.byId.get(id)
        return { node_id: id, parent: node ? (parentKey(node, after.index.byId) || 'root') : null, bounds: rect(after.layout.get(id)) }
      }),
      ...groupIds.map((id) => {
        const group = after.groupById.get(id)
        return { node_id: id, parent: group ? group.parent || 'root' : null, bounds: rect(group?.bounds) }
      })
    ],
    ...(placements.length ? { placed: placements } : {}),
    ...overlapReport(after, subjects)
  }
}

function duplicateNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const asked = stringList(args.node_ids, 'node_ids')
  // A unit is placed as one piece: a node, or all strokes of an ink group.
  const units = asked.map((id) => {
    const target = resolveTarget(s, id)
    return { id, ids: target.kind === 'group' ? target.group.strokes : [id], box: target.box }
  })
  const ids = [...new Set(units.flatMap((unit) => unit.ids))]
  const place = parsePlace(args.place)
  const placeBox = place ? placeTarget(s, place) : null
  const copied = copySubtrees(ids, s.index, s.layout, { detach: false })
  const idMap = copied.idMap ?? new Map<string, string>()
  const reverse = new Map([...idMap].map(([from, to]) => [to, from]))
  const roots = new Set(copied.roots)
  const blocked = obstacles(s)
  const view = viewOf(ctx.board)
  const hidden: string[] = []
  const placements: string[] = []
  // The world shift of each unit that is placed freely, decided once per unit.
  const unitDelta = new Map<string, Point | null>()
  const deltaFor = (sourceId: string): Point | null => {
    const unit = units.find((entry) => entry.ids.includes(sourceId))
    if (!unit) return null
    if (unitDelta.has(unit.id)) return unitDelta.get(unit.id) ?? null
    let delta: Point | null = null
    const box = unit.box
    const topLevelUnit = unit.ids.every((id) => {
      const node = s.index.byId.get(id)
      return !!node && parentKey(node, s.index.byId) === ROOT
    })
    if (box && (place || topLevelUnit)) {
      const size = { width: box.width, height: box.height }
      const spot = place && placeBox ? placeRelative(place, placeBox, size, blocked, view) : findSpot(size, box, blocked, view)
      if ('placed' in spot) placements.push(`${unit.id}: ${spot.placed}`)
      if (!spot.visible) hidden.push(unit.id)
      blocked.push({ x: spot.x, y: spot.y, ...size })
      delta = [spot.x - box.x, spot.y - box.y]
    }
    unitDelta.set(unit.id, delta)
    return delta
  }
  const zNext = new Map<string, number>()
  const nodes = copied.nodes.map((node) => {
    if (!roots.has(node.id) || !isKnown(node)) return node
    const sourceId = reverse.get(node.id) ?? ''
    const source = s.index.byId.get(sourceId) as BoardNode
    const key = parentKey(node, s.index.byId)
    if (isFlowed(node, s.index.byId)) {
      // Right after the original in the flex order.
      const siblings = (s.index.children.get(key) ?? []).filter((sibling) => sibling.id !== source.id)
      const z = typeof source.z === 'number' ? source.z + 0.5 / (1 + (zNext.get(key) ?? 0)) : zAbove(siblings)
      zNext.set(key, (zNext.get(key) ?? 0) + 1)
      return { ...node, z } as BoardNode
    }
    const z = zNext.get(key) ?? zAbove(s.index.children.get(key) ?? [])
    zNext.set(key, z + 1)
    const delta = deltaFor(sourceId)
    if (delta) return { ...node, z, x: node.x + delta[0], y: node.y + delta[1] } as BoardNode
    return { ...node, z, x: node.x + 20, y: node.y + 20 } as BoardNode
  })
  ctx.board.agentCommit([...s.nodes, ...nodes])
  const after = scene(ctx)
  ctx.presence.mark(ctx.agent, topLevels(after, copied.roots))
  const top: Record<string, string | string[]> = {}
  const unitCopies = units.map((unit) => ({ unit, copies: unit.ids.map((id) => idMap.get(id)).filter((id): id is string => !!id) }))
  for (const { unit, copies } of unitCopies) {
    if (isGroupId(unit.id)) {
      // The copy of a group is a new group: name it by its id when the strokes cluster together.
      const group = after.groups.find((entry) => copies.length && copies.every((id) => entry.strokes.includes(id)))
      top[unit.id] = group ? group.id : copies
    } else if (copies.length) top[unit.id] = copies[0]
  }
  const descendants: Record<string, string> = {}
  for (const [from, to] of idMap) if (!ids.includes(from)) descendants[from] = to
  return {
    duplicates: top,
    ...(Object.keys(descendants).length ? { descendant_ids: descendants } : {}),
    bounds: Object.fromEntries(copied.roots.map((id) => [id, rect(after.layout.get(id))])),
    ...(placements.length ? { placed: placements } : {}),
    ...(hidden.length ? { outside_view: hidden } : {}),
    ...overlapReport(
      after,
      unitCopies.map(({ unit, copies }) => {
        if (!isGroupId(unit.id)) return copies.length ? nodeSubject(after, copies[0]) : null
        const box = unionRegions(copies.map((id) => after.layout.get(id)))
        return box ? { box, own: new Set(copies) } : null
      })
    )
  }
}

function deleteNodes(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const ids = expandIds(s, stringList(args.node_ids, 'node_ids'))
  const next = removeNodes(s.nodes, ids, s.index)
  const left = new Set(next.map((node) => node.id))
  const removed = s.nodes.filter((node) => !left.has(node.id)).map((node) => ({ id: node.id, kind: node.kind, author: node.author }))
  const locked = ids.filter((id) => left.has(id))
  const tops = topLevels(s, ids).filter((id) => left.has(id))
  ctx.board.agentCommit(next)
  if (tops.length) ctx.presence.mark(ctx.agent, tops)
  return { removed, ...(locked.length ? { not_removed_locked: locked } : {}) }
}

// ---------- Agent ink ----------

/** Named colours draw_ink accepts (palette names and the agent tokens). */
const INK_NAMES: Record<string, string> = {
  white: '#ececef',
  yellow: '#f5d76e',
  blue: '#6ea8ff',
  green: '#5fd38d',
  pink: '#ff6b8b',
  orange: '#ff9f45',
  red: '#ff6b8b',
  accent: '#6e8bff',
  good: '#5fd38d',
  bad: '#ff6b8b',
  warn: '#f5d76e',
  text: '#ececef'
}
/** Defaults by intent, then fallbacks when the learner writes in a close colour. */
const DEFAULT_INK = ['#6e8bff', '#ff9f45', '#ff6b8b', '#5fd38d', '#f5d76e']

function hexRgb(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1]
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

function closeColors(a: string, b: string): boolean {
  const x = hexRgb(a)
  const y = hexRgb(b)
  if (!x || !y) return a.trim().toLowerCase() === b.trim().toLowerCase()
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 70
}

function inkColor(value: unknown, shape: Shape | undefined, learner: string): string {
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim()
    const token = /^var\(--ls-([a-z-]+)\)$/i.exec(raw)?.[1] ?? raw.toLowerCase()
    if (INK_NAMES[token]) return INK_NAMES[token]
    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw) || /^(rgb|hsl)a?\([^()]*\)$/i.test(raw)) return raw
    throw new Error(`color "${raw}" is not a hex colour, rgb()/hsl(), or one of: ${Object.keys(INK_NAMES).join(', ')}.`)
  }
  const preferred = shape === 'circle' || shape === 'cross' ? INK_NAMES.pink : shape === 'tick' ? INK_NAMES.green : INK_NAMES.accent
  return [preferred, ...DEFAULT_INK].find((color) => !closeColors(color, learner)) ?? preferred
}

function readStrokes(value: unknown): Point[][] {
  if (!Array.isArray(value) || !value.length) throw new Error('strokes must be a non-empty list of strokes, each a list of [x, y] points.')
  return value.map((stroke, i) => {
    if (!Array.isArray(stroke) || !stroke.length) throw new Error(`strokes[${i}] must be a non-empty list of [x, y] points.`)
    const line = stroke.map((point, j) => {
      if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new Error(`strokes[${i}][${j}] must be [x, y] with numbers.`)
      }
      return [Number(point[0]), Number(point[1])] as Point
    })
    // A single point is a dot.
    return line.length === 1 ? [line[0], [line[0][0] + 0.5, line[0][1] + 0.5] as Point] : line
  })
}

function linesBounds(lines: Point[][]): Region {
  let x = Infinity
  let y = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const line of lines) {
    for (const [px, py] of line) {
      x = Math.min(x, px)
      y = Math.min(y, py)
      right = Math.max(right, px)
      bottom = Math.max(bottom, py)
    }
  }
  return { x, y, width: right - x, height: bottom - y }
}

function drawInk(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const tool = args.tool === undefined || args.tool === 'pen' ? 'pen' : args.tool === 'highlighter' ? 'highlighter' : null
  if (!tool) throw new Error('tool must be "pen" or "highlighter".')
  const width = typeof args.width === 'number' && Number.isFinite(args.width) ? Math.max(0.5, Math.min(40, args.width)) : 3.5
  const jitter = typeof args.jitter === 'number' && Number.isFinite(args.jitter) ? Math.max(0, Math.min(1, args.jitter)) : 0.3
  const view = viewOf(ctx.board)
  let lines: Point[][]
  let placed: string | undefined
  let shape: Shape | undefined
  let anchorBox: Region | null = null

  if (args.shape !== undefined) {
    if (typeof args.shape !== 'string' || !SHAPES.includes(args.shape as Shape)) throw new Error(`shape must be one of ${SHAPES.join(', ')}.`)
    shape = args.shape as Shape
    if (args.strokes !== undefined || args.svg_path !== undefined) throw new Error('Give shape (with target), or strokes, or svg_path: one of them.')
    const target = resolveTarget(s, args.target, 'target')
    if (!target.box) throw new Error(`"${target.id}" has no layout, so nothing can be drawn around it.`)
    const from = args.from_id === undefined ? null : resolveTarget(s, args.from_id, 'from_id').box
    const side = args.side === undefined ? undefined : (args.side as ArrowSide)
    if (side !== undefined && !['left', 'right', 'above', 'below'].includes(side)) throw new Error('side must be "left", "right", "above" or "below".')
    lines = shapeLines(shape, target.box, { from, side })
    anchorBox = target.box
    placed = `${shape} ${shape === 'circle' ? 'around' : shape === 'underline' ? 'under' : shape === 'arrow' ? 'to' : 'next to'} ${target.id}${from ? ` from ${String(args.from_id)}` : ''}`
  } else {
    if ((args.strokes === undefined) === (args.svg_path === undefined)) throw new Error('Give exactly one of strokes, svg_path or shape.')
    lines = args.strokes !== undefined ? readStrokes(args.strokes) : svgPathPolylines(String(args.svg_path ?? ''))
    if (!lines.length) throw new Error('The ink has no strokes.')
    const place = parsePlace(args.place)
    if (place) {
      // The drawing's own bounds are placed; its coordinates only give the shape.
      const box = linesBounds(lines)
      const size = { width: Math.max(1, box.width), height: Math.max(1, box.height) }
      anchorBox = placeTarget(s, place)
      const spot = placeRelative(place, anchorBox, size, obstacles(s), view)
      placed = spot.placed
      lines = lines.map((line) => line.map(([x, y]) => [x - box.x + spot.x, y - box.y + spot.y] as Point))
    } else if (typeof args.x === 'number' || typeof args.y === 'number') {
      const ox = args.x === undefined ? 0 : coordArg(args.x, 'x')
      const oy = args.y === undefined ? 0 : coordArg(args.y, 'y')
      lines = lines.map((line) => line.map(([x, y]) => [x + ox, y + oy] as Point))
    }
  }
  if (lines.length > MAX_INK_LINES) throw new Error(`Too many strokes (${lines.length}); the limit is ${MAX_INK_LINES}.`)
  // Checked before humanize() densifies the lines, so a long segment cannot allocate millions of points.
  if (inkPointBudget(lines) > MAX_INK_POINTS) throw new Error(`The ink is too long: over ${MAX_INK_POINTS} points (one every 2.5 board points). Use fewer or shorter strokes.`)
  const inkLines = lines.map((line) => humanize(line, jitter))
  const box = linesBounds(inkLines.map((line) => line.map(([x, y]) => [x, y] as Point)))

  // The parent: as given, else the top-level frame that holds most of the drawing (the learner's rule).
  let parent: string | undefined
  if (args.parent_id !== undefined && args.parent_id !== 'root') {
    const node = requireNode(s, args.parent_id, 'parent_id')
    if (!isFrame(node)) throw new Error(`parent_id "${node.id}" is a ${node.kind}; only frames hold ink.`)
    parent = node.id
  } else if (args.parent_id === undefined) {
    const frames = (s.index.children.get(ROOT) ?? []).filter(isFrame).filter((frame) => frame.style.display !== 'none')
    const host = [...frames].reverse().find((frame) => {
      const frameBox = s.layout.get(frame.id)
      return frameBox ? overlapShare({ ...box, width: Math.max(1, box.width), height: Math.max(1, box.height) }, frameBox) >= 0.6 : false
    })
    parent = host?.id
  }
  const parentBox = parent ? s.layout.get(parent) : undefined
  const origin: Point = parentBox ? [parentBox.ox, parentBox.oy] : [0, 0]
  const z0 = zAbove(s.index.children.get(parent ?? ROOT) ?? [])
  const color = inkColor(args.color, shape, ctx.board.liveState().inkColor)
  const strokes: InkNode[] = inkLines.map((points, i) =>
    normalizeInk({
      id: newItemId('s'),
      kind: 'ink',
      x: -origin[0],
      y: -origin[1],
      z: z0 + i,
      author: 'agent',
      seq: 0,
      tool,
      color,
      width: Math.round(width * (tool === 'highlighter' ? 4 : 1) * 100) / 100,
      points,
      ...(parent ? { parent } : {})
    })
  )
  ctx.board.agentCommit([...s.nodes, ...strokes])
  const ids = strokes.map((stroke) => stroke.id)
  const groupId = ctx.tracker.pin(ids)
  const after = scene(ctx)
  ctx.presence.mark(ctx.agent, topLevels(after, ids))
  const group = after.groupById.get(groupId)
  return {
    group: groupId,
    strokes: ids,
    bounds: rect(group?.bounds),
    color,
    parent: parent ?? 'root',
    ...(placed ? { placed } : {}),
    visible: group ? inside(group.bounds, view) : false,
    ...overlapReport(after, [group ? groupSubject(group) : null])
  }
}

// ---------- Space and view ----------

function findSpaceTool(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const width = Number(args.width)
  const height = Number(args.height)
  if (!(width > 0) || !(height > 0) || !(width <= MAX_BOX_SIZE) || !(height <= MAX_BOX_SIZE)) {
    throw new Error(`width and height must be positive numbers up to ${MAX_BOX_SIZE} board points.`)
  }
  const view = viewOf(ctx.board)
  const near = args.near === undefined ? null : resolveTarget(s, args.near, 'near')
  const anchor = near?.box ?? { x: view.x + view.width / 2 - 1, y: view.y + view.height / 2 - 1, width: 2, height: 2 }
  const spot = findSpace({ width, height }, anchor, obstacles(s), view, args.inside_view !== false)
  if (!spot) throw new Error('No empty space of that size was found near the target. Try a smaller size or another target.')
  return {
    ...spot,
    near: near ? near.id : 'the centre of the learner’s view',
    ...(spot.visible ? {} : { note: 'No free spot of that size is inside the learner’s view; this one is outside it.' })
  }
}

/** The learner wrote this recently (ms): focus waits. */
const FOCUS_QUIET_MS = 2000

function focus(ctx: EditContext, s: Scene, args: Record<string, unknown>): unknown {
  const state = ctx.board.liveState()
  const view = viewOf(ctx.board)
  if (state.drawing || Date.now() - state.learnerInkAt < FOCUS_QUIET_MS) {
    return { skipped: true, reason: 'The learner is writing right now, so the view was not moved. Try again later, or tell them where to look.', viewport: rect(view) }
  }
  let region: Region
  if (args.node_id !== undefined) {
    const target = resolveTarget(s, args.node_id)
    if (!target.box) throw new Error(`"${target.id}" has no layout.`)
    region = target.box
  } else if (args.region && typeof args.region === 'object') {
    const r = args.region as Record<string, unknown>
    region = { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
      throw new Error('region needs {x, y, width, height} with width and height > 0.')
    }
  } else {
    throw new Error('Give node_id (a node or ink group) or region.')
  }
  const padding = typeof args.padding === 'number' && Number.isFinite(args.padding) ? Math.max(0, Math.min(MAX_COORD, args.padding)) : 48
  const padded = { x: region.x - padding, y: region.y - padding, width: region.width + padding * 2, height: region.height + padding * 2 }
  const [vw, vh] = state.viewport
  const current = state.camera.zoom
  const asked = typeof args.zoom === 'number' && Number.isFinite(args.zoom) ? clampZoom(args.zoom) : null
  if (asked === null && inside(padded, view)) return { moved: false, note: 'That is already in the learner’s view.', viewport: rect(view), zoom: current }
  const fits = padded.width * current <= vw && padded.height * current <= vh
  const zoom = asked ?? (fits ? current : clampZoom(Math.min(vw / padded.width, vh / padded.height)))
  const center: Point = [padded.x + padded.width / 2, padded.y + padded.height / 2]
  ctx.board.animateTo({ center, zoom })
  const width = vw / zoom
  const height = vh / zoom
  return { moved: true, viewport: rect({ x: center[0] - width / 2, y: center[1] - height / 2, width, height }), zoom: Math.round(zoom * 1000) / 1000 }
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
    case 'createFrame':
      return createFrame(ctx, scene(ctx), args)
    case 'writeHtml':
      return writeHtml(ctx, args)
    case 'updateStyles':
      return updateStyles(ctx, scene(ctx), args)
    case 'setText':
      return setText(ctx, scene(ctx), args)
    case 'moveNodes':
      return moveNodes(ctx, scene(ctx), args)
    case 'duplicateNodes':
      return duplicateNodes(ctx, scene(ctx), args)
    case 'deleteNodes':
      return deleteNodes(ctx, scene(ctx), args)
    case 'drawInk':
      return drawInk(ctx, scene(ctx), args)
    case 'findSpace':
      return findSpaceTool(ctx, scene(ctx), args)
    case 'focus':
      return focus(ctx, scene(ctx), args)
    case 'sceneContext':
      return sceneContext(ctx.board, scene(ctx))
    case 'runScene':
      return runScene({ board: ctx.board, scene: () => scene(ctx), tracker: ctx.tracker }, args)
    case 'finishWorking': {
      const ids = args.node_ids === undefined ? undefined : stringList(args.node_ids, 'node_ids')
      return { released: ctx.presence.finish(ctx.agent.sessionId, ids) }
    }
  }
}
