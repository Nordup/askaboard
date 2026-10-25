import { boardName, isContent, isInk, isLive, type BoardNode } from '@shared/board-format'
import type {
  AgentMethods,
  AgentRequest,
  BoardRect,
  CanvasInfo,
  ChangeSet,
  InkGroupSummary,
  LearnerNews,
  NewsGroup,
  NewsStroke,
  ScreenshotPlan,
  SnapshotLabel,
  SnapshotOutline,
  TopLevelSummary
} from '@shared/space-api'
import type { BoardHandle, LiveBoardState } from '../board/Board'
import type { ChangeLog } from '../board/changes'
import { unionRegions } from '../board/geometry'
import { buildIndex, ROOT } from '../board/scene'
import type { Region } from '../board/types'
import { liveStill, validateLiveCode } from '../live-pixels/registry'
import { AgentPresence, runEditTool } from './edits'
import { isGroupId, trackerFor, type InkGroup } from './groups'
import { scenePlayer } from '../live/player'

/**
 * Answers the MCP server's requests (see AgentMethods in space-api.ts).
 * The renderer owns the live board, unsaved strokes included, so the
 * answers come from here and not from the file on disk.
 */

/** What the App gives the handler, read fresh for every request. */
export interface AgentContext {
  folder: { name: string; root: string } | null
  boards: string[]
  /** The open board's path, when its Board is mounted. */
  openPath: string | null
  board: BoardHandle | null
  changeLog: ChangeLog | null
  tool: string
  /** Open a board and resolve when it is on screen. */
  openBoard(path: string): Promise<void>
  /** See SpaceApi.importAsset. */
  importAsset(src: string): Promise<string>
  presence: AgentPresence
}

/** Padding around the "changes" view, in board points. */
const CHANGES_PAD = 48
/** Padding around the content and selection views, in board points. */
const CONTENT_PAD = 24
/** The largest scale, in image pixels per board point. */
const MAX_SCALE = 4
// Default longest image side: wide shots are for orientation and stay in the agent's context
// for the whole session, so they are smaller; small crops keep detail for reading handwriting.
const WIDE_MAX_SIZE = 1024
const CROP_MAX_SIZE = 1600
/** A shot whose long side is above this many board points is a wide shot. */
const WIDE_EDGE = 1000
/** Padding around a node screenshot, in board points. */
const NODE_PAD = 16
const CHANGED_COLOR = '#6e8bff' // --accent
const REMOVED_COLOR = '#ff6b8b' // --ink-pink
/** Label tags: learner ink, agent ink, content. High contrast on the dark canvas. */
const LABEL_LEARNER = { color: '#f5d76e', textColor: '#151517' }
const LABEL_AGENT = { color: '#5fd38d', textColor: '#151517' }
const LABEL_NODE = { color: '#6e8bff', textColor: '#ffffff' }

const r1 = (value: number): number => Math.round(value * 10) / 10

function rect(region: Region | null): BoardRect | null {
  return region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null
}

function pad(region: Region, amount: number): Region {
  return { x: region.x - amount, y: region.y - amount, width: region.width + amount * 2, height: region.height + amount * 2 }
}

/** World bounds of every node, from the Board's layout cache. */
function allBounds(state: LiveBoardState): Array<Region | null> {
  return state.nodes.map((node) => state.bounds(node.id))
}

function viewportRect(state: LiveBoardState): Region {
  const width = state.viewport[0] / state.camera.zoom
  const height = state.viewport[1] / state.camera.zoom
  return { x: state.camera.center[0] - width / 2, y: state.camera.center[1] - height / 2, width, height }
}

function groupsOf(path: string, board: BoardHandle): InkGroup[] {
  return trackerFor(path).compute(board.liveState())
}

function groupSummary(group: InkGroup): InkGroupSummary {
  return {
    id: group.id,
    author: group.author,
    parent: group.parent || 'root',
    strokes: group.strokes.length,
    bounds: rect(group.bounds) as BoardRect,
    seq: group.seq
  }
}

function canvasBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()
  return value || '#161618'
}

function requireBoard(context: AgentContext): { path: string; board: BoardHandle; log: ChangeLog | null } {
  if (!context.folder) throw new Error('No learning folder is open in Learning Space. Ask the learner to open one.')
  if (!context.openPath || !context.board) {
    throw new Error(
      context.boards.length
        ? `No board is open. Call open_board with one of: ${context.boards.join(', ')}.`
        : 'No board is open, and the folder has no boards yet.'
    )
  }
  return { path: context.openPath, board: context.board, log: context.changeLog }
}

function canvasInfo(context: AgentContext): CanvasInfo {
  const folder = context.folder ? { name: context.folder.name, path: context.folder.root } : null
  const base: CanvasInfo = {
    folder,
    board: null,
    boards: context.boards,
    viewport: null,
    contentBounds: null,
    itemCount: 0,
    selection: { ids: [], bounds: null },
    tool: context.tool,
    zoom: null,
    cursor: null
  }
  if (!context.openPath || !context.board) return base
  const state = context.board.liveState()
  const selected = new Set(state.selectedIds)
  const counts: Record<string, number> = {}
  for (const node of state.nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1
  const index = buildIndex(state.nodes)
  const topLevel: TopLevelSummary[] = []
  const top = index.children.get(ROOT) ?? []
  for (const node of top) {
    if (!isContent(node)) continue
    topLevel.push({ id: node.id, kind: node.kind, ...(node.name ? { name: node.name } : {}), author: node.author, bounds: rect(state.bounds(node.id)) })
  }
  const groups = groupsOf(context.openPath, context.board)
  return {
    ...base,
    board: { path: context.openPath, name: boardName(context.openPath) },
    viewport: rect(viewportRect(state)),
    contentBounds: rect(unionRegions(allBounds(state))),
    itemCount: state.nodes.length,
    selection: {
      ids: [...state.selectedIds],
      bounds: rect(unionRegions(state.nodes.filter((node) => selected.has(node.id)).map((node) => state.bounds(node.id))))
    },
    zoom: Math.round(state.camera.zoom * 1000) / 1000,
    cursor: seenCursor(state),
    counts,
    topLevel,
    inkGroups: groups.map(groupSummary)
  }
}

/** The cursor: the highest seq on the board so far (items and removals). */
function seenCursor(state: LiveBoardState): number {
  return state.nextSeq - 1
}

/** Changes with seq > since (exclusive). since null = "from now" (nothing). */
function changeSet(context: AgentContext, since: number | null): ChangeSet {
  const { path, board, log } = requireBoard(context)
  const state = board.liveState()
  const from = since ?? seenCursor(state)
  const present = new Set(state.nodes.map((node) => node.id))
  const changed = state.nodes
    .filter((node) => node.seq > from)
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      ...(isInk(node) ? { tool: node.tool, color: node.color } : {}),
      ...(typeof node.name === 'string' ? { name: node.name } : {}),
      ...(state.editor(node.id) ? { by: state.editor(node.id) } : {}),
      bounds: rect(state.bounds(node.id)),
      seq: node.seq
    }))
  const removed = (log?.after(from) ?? [])
    .filter((tombstone) => !present.has(tombstone.id))
    .map((tombstone) => ({ id: tombstone.id, bounds: rect(tombstone.bounds), seq: tombstone.seq }))
  const changedIds = new Set(changed.map((item) => item.id))
  const groups = groupsOf(path, board).filter((group) => group.strokes.some((id) => changedIds.has(id)))
  return { board: path, changed, removed, cursor: seenCursor(state), ...(groups.length ? { groups_changed: groups.map(groupSummary) } : {}) }
}

// ---------- Board news: the learner's ink since an agent's last look ----------

const KIND_WORDS: Record<string, string> = { svg: 'SVG', frame: 'frame', text: 'text', image: 'image', live: 'live item' }

/** "your SVG \"Thermal spectra\"", "the learner's text \"Find x\"", or with the id when it has no name. */
function materialLabel(node: BoardNode): string {
  const owner = node.author === 'agent' ? 'your' : "the learner's"
  const kind = KIND_WORDS[node.kind] ?? node.kind
  let label = typeof node.name === 'string' ? node.name.trim() : ''
  if (!label && node.kind === 'text') label = String((node as { text?: unknown }).text ?? '').replace(/[*$\\]/g, '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ')
  if (label.length > 40) label = `${label.slice(0, 39)}…`
  return label ? `${owner} ${kind} "${label}"` : `${owner} ${kind} ${node.id}`
}

/** Where `a` is relative to `b`, and the gap between them (0 when they overlap). */
function relation(a: Region, b: Region): { gap: number; side: string } {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0)
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0)
  if (gapX === 0 && gapY === 0) return { gap: 0, side: 'on' }
  const side = gapX >= gapY ? (a.x >= b.x + b.width ? 'right of' : 'left of') : a.y >= b.y + b.height ? 'below' : 'above'
  return { gap: Math.hypot(gapX, gapY), side }
}

/**
 * Where a region is, in words: inside its frame, else relative to the nearest
 * top-level node or other ink group ('right of your SVG "Thermal spectra"').
 */
function whereText(state: LiveBoardState, groups: InkGroup[], region: Region, parent: string, skip: Set<string>): string | null {
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  if (parent && parent !== ROOT) {
    const frame = byId.get(parent)
    if (frame) return `inside ${materialLabel(frame)}`
  }
  let best: { gap: number; text: string } | null = null
  const consider = (bounds: Region | null, label: string): void => {
    if (!bounds) return
    const { gap, side } = relation(region, bounds)
    if (!best || gap < best.gap) best = { gap, text: `${side} ${label}` }
  }
  const index = buildIndex(state.nodes)
  for (const node of index.children.get(ROOT) ?? []) if (isContent(node)) consider(state.bounds(node.id), materialLabel(node))
  for (const group of groups) {
    if (skip.has(group.id)) continue
    consider(group.bounds, `${group.author === 'agent' ? 'your' : "the learner's"} ink group ${group.id}`)
  }
  return (best as { gap: number; text: string } | null)?.text ?? null
}

/** The learner's ink strokes added or erased after `since`. */
function learnerNews(context: AgentContext, since: number): LearnerNews | null {
  if (!context.folder || !context.openPath || !context.board) return null
  const path = context.openPath
  const state = context.board.liveState()
  const groups = groupsOf(path, context.board)
  const groupOf = new Map<string, InkGroup>()
  for (const group of groups) for (const stroke of group.strokes) groupOf.set(stroke, group)

  const added: NewsStroke[] = []
  for (const node of state.nodes) {
    if (!isInk(node) || node.seq <= since) continue
    if ((state.editor(node.id) ?? node.author) !== 'learner') continue
    const at = state.changedAt(node.id)
    const group = groupOf.get(node.id)
    added.push({ id: node.id, seq: node.seq, bounds: rect(state.bounds(node.id)), ...(group ? { group: group.id } : {}), ...(at ? { at } : {}) })
  }
  const present = new Set(state.nodes.map((node) => node.id))
  const erased: NewsStroke[] = (context.changeLog?.after(since) ?? [])
    .filter((tombstone) => tombstone.kind === 'ink' && tombstone.by === 'learner' && !present.has(tombstone.id))
    .map((tombstone) => ({ id: tombstone.id, seq: tombstone.seq, bounds: rect(tombstone.bounds), at: tombstone.at }))

  const newsGroupIds = new Set(added.flatMap((stroke) => (stroke.group ? [stroke.group] : [])))
  const newsGroups: NewsGroup[] = groups
    .filter((group) => newsGroupIds.has(group.id))
    .map((group) => ({ id: group.id, bounds: rect(group.bounds) as BoardRect, where: whereText(state, groups, group.bounds, group.parent, newsGroupIds) }))
  const erasedRegion = unionRegions(erased.map((stroke) => stroke.bounds))
  const scenePauses = scenePlayer.takeNotes()
  return {
    ...(scenePauses.length ? { scenePauses } : {}),
    board: path,
    boardName: boardName(path),
    cursor: seenCursor(state),
    added,
    erased,
    groups: newsGroups,
    erasedWhere: erasedRegion ? whereText(state, groups, erasedRegion, ROOT, new Set()) : null
  }
}

function screenshotPlan(context: AgentContext, params: AgentMethods['screenshotPlan']['params']): ScreenshotPlan {
  const { path, board } = requireBoard(context)
  const state = board.liveState()
  const empty = (message: string): ScreenshotPlan => ({ kind: 'empty', board: path, message, cursor: seenCursor(state) })
  let target: Region | null = null
  let outlines: SnapshotOutline[] = []
  let changeCounts: { changed: number; removed: number } | undefined

  switch (params.target) {
    case 'node': {
      const id = params.nodeId ?? ''
      if (isGroupId(id)) {
        const group = groupsOf(path, board).find((entry) => entry.id === id)
        if (!group) throw new Error(`No ink group "${id}" on the open board. get_canvas_info lists the groups.`)
        target = pad(group.bounds, NODE_PAD)
        break
      }
      if (!state.nodes.some((node) => node.id === id)) throw new Error(`No node "${id}" on the open board. Call get_tree to see the node ids.`)
      const bounds = state.bounds(id)
      if (!bounds) throw new Error(`Node "${id}" has no layout (it may be hidden with display: none).`)
      target = pad(bounds, NODE_PAD)
      break
    }
    case 'viewport':
      target = viewportRect(state)
      break
    case 'content': {
      const content = unionRegions(allBounds(state))
      if (!content) return empty('The board is empty: there is nothing to show.')
      target = pad(content, CONTENT_PAD)
      break
    }
    case 'selection': {
      const selected = new Set(state.selectedIds)
      const bounds = unionRegions(state.nodes.filter((node) => selected.has(node.id)).map((node) => state.bounds(node.id)))
      if (!bounds) return empty('The learner has nothing selected.')
      target = pad(bounds, CONTENT_PAD)
      break
    }
    case 'changes': {
      const changes = changeSet(context, params.since)
      const changedBounds = changes.changed.map((item) => item.bounds).filter((b): b is BoardRect => b !== null)
      const removedBounds = changes.removed.map((item) => item.bounds).filter((b): b is BoardRect => b !== null)
      // Crop to the new material; erased areas set the crop only when nothing is new.
      const all = unionRegions(changedBounds) ?? unionRegions(removedBounds)
      if (!all) {
        return empty(
          params.since === null
            ? 'No changes yet: this was your first look, so your change cursor starts now. Use target "content" or "viewport" to see the board.'
            : 'Nothing changed on the board since your last look.'
        )
      }
      target = pad(all, CHANGES_PAD)
      outlines = [
        ...removedBounds.map((bounds) => ({ rect: pad(bounds, 4), color: REMOVED_COLOR })),
        ...changedBounds.map((bounds) => ({ rect: pad(bounds, 4), color: CHANGED_COLOR }))
      ]
      changeCounts = { changed: changes.changed.length, removed: changes.removed.length }
      board.flash(target)
      break
    }
    case 'region': {
      const region = params.region
      if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
        throw new Error('region needs {x, y, width, height} in board coordinates, with width and height > 0.')
      }
      target = region
      break
    }
  }
  if (!target) throw new Error('Nothing to capture.')

  // The asked scale, capped so the long edge stays within maxSize.
  const longEdge = Math.max(target.width, target.height)
  // max_size always wins, so a huge region gives a small image, never a huge canvas.
  const wide = params.target === 'viewport' || params.target === 'content' || longEdge > WIDE_EDGE
  const maxSize = params.maxSize ?? (wide ? WIDE_MAX_SIZE : CROP_MAX_SIZE)
  const scale = Math.min(MAX_SCALE, params.scale, maxSize / Math.max(1, longEdge))
  const width = Math.max(1, Math.round(target.width * scale))
  const height = Math.max(1, Math.round(target.height * scale))
  const shown = target
  const labels: SnapshotLabel[] = []
  if (params.labels) {
    const visible = (box: Region | null): box is Region =>
      !!box && box.x < shown.x + shown.width && box.x + box.width > shown.x && box.y < shown.y + shown.height && box.y + box.height > shown.y
    const index = buildIndex(state.nodes)
    const ids = new Set((index.children.get(ROOT) ?? []).filter(isContent).map((node) => node.id))
    // A node screenshot also labels the node's direct children.
    if (params.target === 'node' && params.nodeId && !isGroupId(params.nodeId)) {
      for (const child of index.children.get(params.nodeId) ?? []) if (isContent(child)) ids.add(child.id)
    }
    for (const id of ids) {
      const box = state.bounds(id)
      if (visible(box)) labels.push({ rect: rect(box) as BoardRect, text: id, ...LABEL_NODE })
    }
    for (const group of groupsOf(path, board)) {
      if (visible(group.bounds)) labels.push({ rect: rect(group.bounds) as BoardRect, text: group.id, ...(group.author === 'agent' ? LABEL_AGENT : LABEL_LEARNER) })
    }
  }
  // Grid pitch: 100 board points, coarser when the lines would be closer than ~40 px.
  const grid = params.grid ? ([100, 200, 500, 1000, 2000, 5000].find((pitch) => pitch * scale >= 40) ?? 10000) : 0
  // During a live scene: the moment the learner sees now (the scene's look of its nodes, ink that exists only now, ghosts).
  const live = scenePlayer.snapshot()
  return {
    kind: 'plan',
    board: path,
    nodes: (live ? [...state.nodes, ...live.frame.ghosts, ...(live.frame.inks ?? [])] : state.nodes) as unknown[],
    ...(live
      ? {
          playback: { overrides: [...live.frame.overrides], tips: [...live.frame.tips] },
          playing: { scene: live.status.scene ?? '', name: live.status.name, t: live.status.t, duration: live.status.duration, step: live.status.step, paused: live.status.paused }
        }
      : {}),
    rect: rect(target) as BoardRect,
    scale: Math.round(scale * 1000) / 1000,
    width,
    height,
    outlines,
    overlays: { labels, grid },
    changes: changeCounts,
    cursor: seenCursor(state),
    background: canvasBackground()
  }
}

async function openBoard(context: AgentContext, path: string): Promise<void> {
  if (!context.folder) throw new Error('No learning folder is open in Learning Space.')
  if (!context.boards.includes(path)) {
    throw new Error(
      `"${path}" is not a board in this folder. Boards: ${context.boards.length ? context.boards.join(', ') : '(none)'}.`
    )
  }
  await context.openBoard(path)
}

/** Live pixel items carry their current pixels into the snapshot window (`still`, not saved). */
async function withLiveStills(plan: ScreenshotPlan): Promise<ScreenshotPlan> {
  if (plan.kind !== 'plan') return plan
  const nodes = plan.nodes as BoardNode[]
  if (!nodes.some(isLive)) return plan
  const withStills = await Promise.all(nodes.map(async (node) => (isLive(node) ? { ...node, still: (await liveStill(node.id)) ?? undefined } : node)))
  return { ...plan, nodes: withStills }
}

/** Run one request. Throws an Error with an agent-readable message on failure. */
export async function handleAgentRequest(request: AgentRequest, getContext: () => AgentContext): Promise<unknown> {
  const context = getContext()
  switch (request.method) {
    case 'canvasInfo':
      return canvasInfo(context)
    case 'changes':
      return changeSet(context, (request.params as AgentMethods['changes']['params']).since)
    case 'learnerNews': {
      const params = request.params as AgentMethods['learnerNews']['params']
      return learnerNews(context, params.since)
    }
    case 'screenshotPlan':
      return withLiveStills(screenshotPlan(context, request.params as AgentMethods['screenshotPlan']['params']))
    case 'validateLive': {
      const params = request.params as AgentMethods['validateLive']['params']
      return { error: await validateLiveCode(params.mode, params.code, params.params ?? {}) }
    }
    case 'agentTool': {
      const params = request.params as AgentMethods['agentTool']['params']
      const { board } = requireBoard(context)
      context.presence.attach(board)
      const { path } = requireBoard(context)
      const tracker = trackerFor(path)
      return runEditTool(
        { board, agent: params.agent, importAsset: context.importAsset, presence: context.presence, tracker, groups: () => tracker.compute(board.liveState()) },
        params.tool,
        params.args ?? {}
      )
    }
    case 'openBoard': {
      await openBoard(context, (request.params as AgentMethods['openBoard']['params']).path)
      return canvasInfo(getContext())
    }
    default:
      throw new Error(`Unknown request: ${String(request.method)}`)
  }
}
