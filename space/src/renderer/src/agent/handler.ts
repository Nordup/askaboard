import { boardTexts, digestBoard, placeText, relation, searchTexts, unionRegions } from '@shared/board-digest'
import { boardName, isContent, isInk, isKnown, isLive, isOldLive, isShape, kindWord, type BoardNode } from '@shared/board-format'
import type {
  AgentMethods,
  BoardChangeOp,
  BoardChangeResult,
  AgentRequest,
  BoardRect,
  LearnerNews,
  NewsGroup,
  NewsItem,
  NewsStroke,
  ScreenshotPlan,
  SnapshotLabel,
  SnapshotOutline
} from '@shared/space-api'
import type { BoardHandle, LiveBoardState } from '../board/Board'
import { describeChange, type ChangeLog } from '../board/changes'
import { buildIndex, ROOT } from '../board/scene'
import type { Region } from '../board/types'
import { liveStill, validateWorld } from '../live-pixels/registry'
import { sceneStills } from '../live-pixels/stills'
import { sceneAt, type FramesLiveItem, type ScenePlace } from '../live/run'
import { runEditTool } from './edits'
import { trackerFor, type InkGroup } from './groups'
import { scenePlayer } from '../live/player'
import { linkedOverrides, linkedTip, markText, worldOf } from '@shared/world-links'
import { measureSceneTexts } from '../live/measure'
import { sceneHost } from '../live/host'
import { sceneOf, viewOf } from './placement'
import { boardRead, changeReport, intervalOf, itemRead, shotPart, type ItemAs, type PartArg, type ReadContext } from './reads'

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
  /** The open board has changes not saved yet. */
  unsaved: boolean
  /** Open a board and resolve when it is on screen. */
  openBoard(path: string): Promise<void>
  /** The one board-change operation (App.tsx changeBoard). */
  changeBoard(op: BoardChangeOp): Promise<BoardChangeResult>
  /** See SpaceApi.importAsset. */
  importAsset(src: string): Promise<string>
  /** Write the open board's unsaved changes now; false when the write failed. */
  saveNow(): Promise<boolean>
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

function groupsOf(path: string, board: BoardHandle): InkGroup[] {
  return trackerFor(path).compute(board.liveState())
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
        ? `No board is open. list_boards() lists the ${context.boards.length} boards of the folder; open_board({board: "…"}) opens one.`
        : 'No board is open, and the folder has no boards yet: open_board({board: "…", create: true}) makes one.'
    )
  }
  return { path: context.openPath, board: context.board, log: context.changeLog }
}

/** The cursor: the highest seq on the board so far (items and removals). */
function seenCursor(state: LiveBoardState): number {
  return state.nextSeq - 1
}

type SceneNames = Array<{ id: string; name: string | null }>

/** What the reads (reads.ts) need of the open board. */
function readContext(context: AgentContext, scenes: SceneNames): ReadContext {
  const { path, board, log } = requireBoard(context)
  return { path, board, log, groups: groupsOf(path, board), folder: context.folder, boards: context.boards, tool: context.tool, sceneNames: scenes ?? [] }
}

// ---------- Board news: the learner's changes since an agent's last look ----------

const KIND_WORDS: Record<string, string> = { svg: 'svg', frame: 'frame', text: 'text', image: 'image', live: 'world' }

/**
 * "your SVG \"Thermal spectra\"", "the learner's text \"Find x\"", or with the id when it has no name.
 * `owner` false: "a text \"Find x\"" (for a new item).
 */
function materialLabel(node: BoardNode, owner = true): string {
  const kind = KIND_WORDS[node.kind] ?? kindWord(node)
  const who = owner ? (node.author === 'agent' ? 'your' : "the learner's") : /^[aeiou]|^svg/i.test(kind) ? 'an' : 'a'
  let label = typeof node.name === 'string' ? node.name.trim() : ''
  if (!label && node.kind === 'text') label = String((node as { text?: unknown }).text ?? '').replace(/[*$\\]/g, '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ')
  if (!label && node.kind === 'image') {
    const src = String((node as { src?: unknown }).src ?? '')
    if (!src.startsWith('data:')) label = src.slice(src.lastIndexOf('/') + 1)
  }
  if (label.length > 40) label = `${label.slice(0, 39)}…`
  return label ? `${who} ${kind} "${label}"` : `${who} ${kind} ${node.id}`
}

/** 'your SVG', "the learner's text": whose and what kind, for news summaries of many items. */
function materialUnit(node: BoardNode): string {
  return `${node.author === 'agent' ? 'your' : "the learner's"} ${KIND_WORDS[node.kind] ?? kindWord(node)}`
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

/** The learner's changes after `since`: strokes drawn or erased, and every other change (NewsItem). */
function learnerNews(context: AgentContext, since: number): LearnerNews | null {
  if (!context.folder || !context.openPath || !context.board) return null
  const path = context.openPath
  const state = context.board.liveState()
  const log = context.changeLog
  const groups = groupsOf(path, context.board)
  const groupOf = new Map<string, InkGroup>()
  for (const group of groups) for (const stroke of group.strokes) groupOf.set(stroke, group)

  const added: NewsStroke[] = []
  const marks: string[] = []
  const items: NewsItem[] = []
  // New items that are not ink, with their parent: a new item inside a new frame goes with the frame.
  const placed: Array<{ item: NewsItem; parent?: string }> = []
  // Ink moved or resized, per change and ink group.
  const inkMoves = new Map<string, { change: NewsItem['change']; group?: InkGroup; bounds: Region[]; offsets: Set<string>; offset?: { dx: number; dy: number }; at: number; count: number }>()
  const newIds = new Set<string>()
  for (const node of state.nodes) {
    if (node.seq <= since) continue
    if ((state.editor(node.id) ?? node.author) !== 'learner') continue
    const at = state.changedAt(node.id)
    const prior = log?.stateAt(node.id, since) ?? { kind: 'unknown' as const }
    const { change, offset } = describeChange(node, prior)
    if (change === 'unchanged') continue
    // A mark changes the pins of its world: the news names the mark, not the world.
    if (isLive(node) && prior.kind === 'was' && JSON.stringify({ ...node, pins: 0, seq: 0 }) === JSON.stringify({ ...prior.node, pins: 0, seq: 0 })) continue
    const mark = isKnown(node) && change === 'added' ? markText(node.follows, worldOf(state.nodes, node.follows)) : null
    if (mark) marks.push(mark)
    const group = isInk(node) ? groupOf.get(node.id) : undefined
    // A stroke that is new, or whose state before is not known, counts as drawn.
    if (isInk(node) && (change === 'added' || prior.kind === 'unknown')) {
      added.push({ id: node.id, seq: node.seq, bounds: rect(state.bounds(node.id)), ...(group ? { group: group.id } : {}), ...(at ? { at } : {}) })
      continue
    }
    if (change === 'added') newIds.add(node.id)
    if (isInk(node)) {
      const key = `${change} ${group?.id ?? ''}`
      const entry = inkMoves.get(key) ?? { change, ...(group ? { group } : {}), bounds: [], offsets: new Set<string>(), at: 0, count: 0 }
      const bounds = state.bounds(node.id)
      if (bounds) entry.bounds.push(bounds)
      entry.offsets.add(offset ? `${offset.dx},${offset.dy}` : '')
      if (offset) entry.offset = offset
      entry.at = Math.max(entry.at, at ?? 0)
      entry.count++
      inkMoves.set(key, entry)
      continue
    }
    // A new shape is drawn, as a stroke is.
    const item: NewsItem = { change: change === 'added' && isShape(node) ? 'drawn' : change, label: materialLabel(node, change !== 'added'), unit: materialUnit(node), bounds: rect(state.bounds(node.id)), ...(offset ? { offset } : {}), ...(at ? { at } : {}) }
    const parent = isKnown(node) ? node.parent : undefined
    if (change === 'added') placed.push({ item, ...(parent ? { parent } : {}) })
    else items.push(item)
  }
  for (const { item, parent } of placed) if (!parent || !newIds.has(parent)) items.push(item)
  for (const entry of inkMoves.values()) {
    const whose = entry.group?.author === 'agent' ? 'your ' : ''
    const label = entry.group
      ? `${entry.count < entry.group.strokes.length ? `${strokeWord(entry.count)} of ` : ''}${whose}ink group ${entry.group.id}`
      : strokeWord(entry.count)
    // An offset only when every stroke moved by the same one.
    const offset = entry.offsets.size === 1 && entry.offset ? { offset: entry.offset } : {}
    items.push({ change: entry.change, label, unit: 'ink', bounds: rect(unionRegions(entry.bounds)), ...offset, ...(entry.at ? { at: entry.at } : {}) })
  }

  const present = new Set(state.nodes.map((node) => node.id))
  const removals = (context.changeLog?.after(since) ?? []).filter((tombstone) => tombstone.by === 'learner' && !present.has(tombstone.id))
  const erased: NewsStroke[] = removals
    .filter((tombstone) => tombstone.kind === 'ink')
    .map((tombstone) => ({ id: tombstone.id, seq: tombstone.seq, bounds: rect(tombstone.bounds), at: tombstone.at }))
  const deletedIds = new Set(removals.map((tombstone) => tombstone.id))
  for (const tombstone of removals) {
    if (tombstone.kind === 'ink' || !tombstone.node) continue
    // The contents of a deleted frame go with it.
    const parent = isKnown(tombstone.node) ? tombstone.node.parent : undefined
    if (parent && deletedIds.has(parent)) continue
    // A shape is erased, as a stroke is (by the eraser or by Delete).
    items.push({ change: tombstone.kind === 'shape' ? 'erased' : 'deleted', label: materialLabel(tombstone.node), unit: materialUnit(tombstone.node), bounds: rect(tombstone.bounds), at: tombstone.at })
  }

  const newsGroupIds = new Set(added.flatMap((stroke) => (stroke.group ? [stroke.group] : [])))
  const newsGroups: NewsGroup[] = groups
    .filter((group) => newsGroupIds.has(group.id))
    .map((group) => ({ id: group.id, bounds: rect(group.bounds) as BoardRect, where: whereText(state, groups, group.bounds, group.parent, newsGroupIds) }))
  const erasedRegion = unionRegions(erased.map((stroke) => stroke.bounds))
  const scenePauses = scenePlayer.takeNotes()
  return {
    ...(scenePauses.length ? { scenePauses } : {}),
    ...(marks.length ? { marks } : {}),
    board: path,
    boardName: boardName(path),
    cursor: seenCursor(state),
    added,
    erased,
    groups: newsGroups,
    erasedWhere: erasedRegion ? whereText(state, groups, erasedRegion, ROOT, new Set()) : null,
    items
  }
}

const strokeWord = (count: number): string => `${count} stroke${count === 1 ? '' : 's'}`

function screenshotPlan(context: AgentContext, params: AgentMethods['screenshotPlan']['params']): ScreenshotPlan {
  const { path, board, log } = requireBoard(context)
  const state = board.liveState()
  const empty = (message: string): ScreenshotPlan => ({ kind: 'empty', board: path, message, cursor: seenCursor(state) })
  let target: Region | null = null
  let outlines: SnapshotOutline[] = []
  let changeCounts: { changed: number; removed: number; handle: string } | undefined
  const ctx = readContext(context, params.scenes)
  const part = shotPart(ctx, params.part as PartArg | undefined)
  let wide = false
  let labelIds: string[] | null = null
  switch (part.kind) {
    case 'empty':
      return empty(part.message)
    case 'changes': {
      const interval = intervalOf(state, log, part.from, part.to)
      const changedBounds = interval.changed.map((entry) => state.bounds(entry.node.id)).filter((b): b is Region => b !== null)
      const removedBounds = interval.removed.map((tombstone) => tombstone.bounds).filter((b): b is Region => b !== null)
      // Crop to the new material; erased areas set the crop only when nothing is new.
      const all = unionRegions(changedBounds) ?? unionRegions(removedBounds)
      if (!all) return empty(`Nothing changed in the interval ${part.handle}.`)
      target = pad(all, CHANGES_PAD)
      outlines = [
        ...removedBounds.map((bounds) => ({ rect: pad(bounds, 4), color: REMOVED_COLOR })),
        ...changedBounds.map((bounds) => ({ rect: pad(bounds, 4), color: CHANGED_COLOR }))
      ]
      changeCounts = { changed: interval.changed.length, removed: interval.removed.length, handle: part.handle }
      board.flash(target)
      break
    }
    default: {
      if (!part.rect) return empty(part.kind === 'selection' ? 'The learner has nothing selected.' : 'The board is empty: there is nothing to show.')
      wide = part.wide
      labelIds = part.labelIds
      target = part.kind === 'view' || part.kind === 'region' ? part.rect : pad(part.rect, part.kind === 'board' || part.kind === 'selection' ? CONTENT_PAD : NODE_PAD)
    }
  }
  if (!target) throw new Error('Nothing to capture.')
  const what = part.what

  // The asked scale, capped so the long edge stays within maxSize.
  const longEdge = Math.max(target.width, target.height)
  // max_size always wins, so a huge region gives a small image, never a huge canvas.
  const maxSize = params.maxSize ?? (wide || longEdge > WIDE_EDGE ? WIDE_MAX_SIZE : CROP_MAX_SIZE)
  const scale = Math.min(MAX_SCALE, params.scale, maxSize / Math.max(1, longEdge))
  const width = Math.max(1, Math.round(target.width * scale))
  const height = Math.max(1, Math.round(target.height * scale))
  const shown = target
  const labels: SnapshotLabel[] = []
  if (params.labels) {
    const visible = (box: Region | null): box is Region =>
      !!box && box.x < shown.x + shown.width && box.x + box.width > shown.x && box.y < shown.y + shown.height && box.y + box.height > shown.y
    const groups = ctx.groups
    const groupIds = new Set(groups.map((group) => group.id))
    // Labels name the part's own units (a scene's items, an item and what it holds), else the top-level items and ink groups in the image.
    const index = buildIndex(state.nodes)
    const ids = labelIds ?? [...(index.children.get(ROOT) ?? []).filter(isContent).map((node) => node.id), ...groups.map((group) => group.id)]
    for (const id of new Set(ids)) {
      if (groupIds.has(id)) {
        const group = groups.find((entry) => entry.id === id) as InkGroup
        if (visible(group.bounds)) labels.push({ rect: rect(group.bounds) as BoardRect, text: group.id, ...(group.author === 'agent' ? LABEL_AGENT : LABEL_LEARNER) })
        continue
      }
      const box = state.bounds(id)
      if (visible(box)) labels.push({ rect: rect(box) as BoardRect, text: id, ...LABEL_NODE })
    }
  }
  // Grid pitch: 100 board points, coarser when the lines would be closer than ~40 px.
  const grid = params.grid ? ([100, 200, 500, 1000, 2000, 5000].find((pitch) => pitch * scale >= 40) ?? 10000) : 0
  // During a live scene: the moment the learner sees now (the scene's look of its nodes, ink that exists only now, ghosts).
  const live = scenePlayer.snapshot()
  // Items that follow a point of a world show where they are now.
  const linked = linkedOverrides(state.nodes.filter(isKnown), live ? [...live.frame.overrides] : [], board.worldPoints())
  return {
    kind: 'plan',
    board: path,
    nodes: (live ? [...state.nodes, ...live.frame.ghosts, ...(live.frame.inks ?? [])] : state.nodes) as unknown[],
    ...(linked.length && !live ? { playback: { overrides: linked, tips: [] } } : {}),
    ...(live
      ? {
          playback: { overrides: linked, tips: live.frame.tips.map((tip) => linkedTip(tip, board.worldPoints())) },
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
    what,
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

/** Worlds carry their current pixels into the snapshot window (`still`, not saved). */
async function withLiveStills(plan: ScreenshotPlan): Promise<ScreenshotPlan> {
  if (plan.kind !== 'plan') return plan
  const nodes = plan.nodes as BoardNode[]
  if (!nodes.some(isLive)) return plan
  const withStills = await Promise.all(
    nodes.map(async (node) => {
      if (!isLive(node) || isOldLive(node)) return node
      const still = await liveStill(node.id)
      return { ...node, still: still?.url ?? undefined, ...(still?.box ? { stillBox: still.box } : {}) }
    })
  )
  return { ...plan, nodes: withStills }
}

/** Stills of live items for preview frames: the scene's moments from step hosts, the other items as they are on the board now. */
async function liveStillsOf(params: AgentMethods['liveStills']['params']): Promise<AgentMethods['liveStills']['result']> {
  const items = params.items as FramesLiveItem[]
  const stepped = items.filter((item) => item.timeline).map((item) => ({ ...item, moments: item.moments.filter((moment): moment is { frame: number; t: number } => moment.t !== null) }))
  const onBoard = items.flatMap((item) => item.moments.filter((moment) => moment.t === null).map((moment) => ({ id: item.node.id, frame: moment.frame })))
  // An item as it is now: one picture, the same in every frame.
  const [scene, now] = await Promise.all([
    sceneStills(stepped, params.scale),
    Promise.all([...new Set(onBoard.map((entry) => entry.id))].map(async (id) => [id, await liveStill(id)] as const)).then((pictures) => new Map(pictures))
  ])
  const board = onBoard.map(({ id, frame }) => {
    const still = now.get(id)
    return { frame, id, url: still?.url ?? null, tick: still?.tick ?? null, ...(still?.points ? { points: still.points } : {}), ...(still?.box ? { box: still.box } : {}) }
  })
  return { stills: [...scene, ...board] }
}

/** Run one request. Throws an Error with an agent-readable message on failure. */
export async function handleAgentRequest(request: AgentRequest, getContext: () => AgentContext): Promise<unknown> {
  const context = getContext()
  switch (request.method) {
    case 'saveBoard':
      return { saved: await context.saveNow() }
    case 'cursorInfo': {
      if (!context.openPath || !context.board) return { board: null, cursor: null }
      return { board: { path: context.openPath }, cursor: seenCursor(context.board.liveState()) }
    }
    case 'boardRead': {
      const params = request.params as AgentMethods['boardRead']['params']
      const ctx = readContext(context, params.scenes)
      return { board: ctx.path, cursor: seenCursor(ctx.board.liveState()), text: boardRead(ctx, { part: params.part as PartArg | undefined, query: params.query, depth: params.depth, look: params.look }) }
    }
    case 'itemRead': {
      const params = request.params as AgentMethods['itemRead']['params']
      return itemRead(readContext(context, params.scenes), { id: params.id, as: params.as as ItemAs | undefined, include_ids: params.include_ids })
    }
    case 'changeReport': {
      const params = request.params as AgentMethods['changeReport']['params']
      return changeReport(readContext(context, params.scenes), params)
    }
    case 'learnerNews': {
      const params = request.params as AgentMethods['learnerNews']['params']
      return learnerNews(context, params.since)
    }
    case 'boardView': {
      if (!context.openPath || !context.board) return null
      const [width, height] = context.board.liveState().viewport
      return { viewport: [width, height], view: rect(viewOf(context.board)) as BoardRect }
    }
    case 'screenshotPlan':
      return withLiveStills(screenshotPlan(context, request.params as AgentMethods['screenshotPlan']['params']))
    case 'measureText': {
      const params = request.params as AgentMethods['measureText']['params']
      return { sizes: await measureSceneTexts(params.items) }
    }
    case 'sceneHost': {
      const params = request.params as AgentMethods['sceneHost']['params']
      const { board, path } = requireBoard(context)
      const tracker = trackerFor(path)
      // A new version of a scene asks about the board at that scene's place, as its context shows it (live/run.ts sceneAt).
      const place = (params.place as ScenePlace | undefined) ?? null
      return sceneHost({ board, scene: () => sceneAt(sceneOf(board, () => tracker.compute(board.liveState())), place).scene, importAsset: context.importAsset }, params.request)
    }
    case 'validateLive': {
      const params = request.params as AgentMethods['validateLive']['params']
      return { error: await validateWorld(params.code, params.params ?? {}, params.size, params.data) }
    }
    case 'liveStills':
      return liveStillsOf(request.params as AgentMethods['liveStills']['params'])
    case 'agentTool': {
      const params = request.params as AgentMethods['agentTool']['params']
      const { board } = requireBoard(context)
      const { path } = requireBoard(context)
      const tracker = trackerFor(path)
      return runEditTool(
        { board, importAsset: context.importAsset, tracker, groups: () => tracker.compute(board.liveState()), path, ...(context.folder ? { root: context.folder.root } : {}) },
        params.tool,
        params.args ?? {}
      )
    }
    case 'boardDigest': {
      const params = request.params as AgentMethods['boardDigest']['params']
      if (!context.folder || !context.openPath || !context.board) return null
      const state = context.board.liveState()
      const nodes = state.nodes as BoardNode[]
      const groups = groupsOf(context.openPath, context.board).filter((group) => group.author === 'learner').length
      const matches = params.query ? searchTexts(boardTexts(nodes), params.query).map((match) => ({ ...match, place: placeText(state.bounds(match.id)) })) : undefined
      return { path: context.openPath, unsaved: context.unsaved, digest: digestBoard(nodes), groups, ...(matches ? { matches } : {}) }
    }
    case 'boardChange': {
      if (!context.folder) throw new Error('No learning folder is open in Learning Space.')
      return context.changeBoard(request.params as AgentMethods['boardChange']['params'])
    }
    case 'openBoard': {
      const params = request.params as AgentMethods['openBoard']['params']
      await openBoard(context, params.path)
      const ctx = readContext(getContext(), params.scenes)
      return { board: ctx.path, cursor: seenCursor(ctx.board.liveState()), text: boardRead(ctx, { look: params.look }) }
    }
    default:
      throw new Error(`Unknown request: ${String(request.method)}`)
  }
}
