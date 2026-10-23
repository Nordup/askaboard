import { boardName, isStroke } from '@shared/board-format'
import type {
  AgentMethods,
  AgentRequest,
  BoardRect,
  CanvasInfo,
  ChangeSet,
  ScreenshotResult
} from '@shared/space-api'
import type { BoardHandle, LiveBoardState } from '../board/Board'
import type { ChangeLog } from '../board/changes'
import { strokeBounds, unionRegions } from '../board/geometry'
import { renderRegion, type RenderOutline } from '../board/paint'
import type { BoardItem, Region } from '../board/types'

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
}

/** Padding around the "changes" view, in board points. */
const CHANGES_PAD = 48
/** Padding around the content and selection views, in board points. */
const CONTENT_PAD = 24
/** The largest scale, in image pixels per board point. Small regions stay sharp but not huge. */
const MAX_SCALE = 2
const CHANGED_COLOR = '#6e8bff' // --accent
const REMOVED_COLOR = '#ff6b8b' // --ink-pink

const r1 = (value: number): number => Math.round(value * 10) / 10

function rect(region: Region | null): BoardRect | null {
  return region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null
}

function pad(region: Region, amount: number): Region {
  return { x: region.x - amount, y: region.y - amount, width: region.width + amount * 2, height: region.height + amount * 2 }
}

function itemBounds(item: BoardItem): Region | null {
  return isStroke(item) ? strokeBounds(item) : null
}

function viewportRect(state: LiveBoardState): Region {
  const width = state.viewport[0] / state.camera.zoom
  const height = state.viewport[1] / state.camera.zoom
  return { x: state.camera.center[0] - width / 2, y: state.camera.center[1] - height / 2, width, height }
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
  return {
    ...base,
    board: { path: context.openPath, name: boardName(context.openPath) },
    viewport: rect(viewportRect(state)),
    contentBounds: rect(unionRegions(state.items.map(itemBounds))),
    itemCount: state.items.length,
    selection: {
      ids: [...state.selectedIds],
      bounds: rect(unionRegions(state.items.filter((item) => selected.has(item.id)).map(itemBounds)))
    },
    zoom: Math.round(state.camera.zoom * 1000) / 1000,
    cursor: seenCursor(state)
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
  const present = new Set(state.items.map((item) => item.id))
  const changed = state.items
    .filter((item) => item.seq > from)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(isStroke(item) ? { tool: item.tool, color: item.color } : {}),
      bounds: rect(itemBounds(item)),
      seq: item.seq
    }))
  const removed = (log?.after(from) ?? [])
    .filter((tombstone) => !present.has(tombstone.id))
    .map((tombstone) => ({ id: tombstone.id, bounds: rect(tombstone.bounds), seq: tombstone.seq }))
  return { board: path, changed, removed, cursor: seenCursor(state) }
}

function screenshot(context: AgentContext, params: AgentMethods['screenshot']['params']): ScreenshotResult {
  const { path, board } = requireBoard(context)
  const state = board.liveState()
  const empty = (message: string): ScreenshotResult => ({ kind: 'empty', board: path, message, cursor: seenCursor(state) })
  let target: Region | null = null
  let outlines: RenderOutline[] = []
  let changeCounts: { changed: number; removed: number } | undefined

  switch (params.target) {
    case 'viewport':
      target = viewportRect(state)
      break
    case 'content': {
      const content = unionRegions(state.items.map(itemBounds))
      if (!content) return empty('The board is empty: there is no ink to show.')
      target = pad(content, CONTENT_PAD)
      break
    }
    case 'selection': {
      const selected = new Set(state.selectedIds)
      const bounds = unionRegions(state.items.filter((item) => selected.has(item.id)).map(itemBounds))
      if (!bounds) return empty('The learner has nothing selected.')
      target = pad(bounds, CONTENT_PAD)
      break
    }
    case 'changes': {
      const changes = changeSet(context, params.since)
      const changedBounds = changes.changed.map((item) => item.bounds).filter((b): b is BoardRect => b !== null)
      const removedBounds = changes.removed.map((item) => item.bounds).filter((b): b is BoardRect => b !== null)
      // Crop to the new ink; erased areas set the crop only when nothing is new.
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
        throw new Error('target "region" needs region: {x, y, width, height} in board coordinates, with width and height > 0.')
      }
      target = region
      break
    }
  }

  const scale = Math.min(MAX_SCALE, params.maxSize / Math.max(target.width, target.height))
  const render = renderRegion(state.items, target, scale, canvasBackground(), outlines)
  if (!render) throw new Error('The renderer could not create a 2D canvas.')
  const png = render.canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
  return {
    kind: 'image',
    board: path,
    png,
    rect: rect(target) as BoardRect,
    scale: Math.round(scale * 1000) / 1000,
    width: render.width,
    height: render.height,
    changes: changeCounts,
    cursor: seenCursor(state)
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

/** Run one request. Throws an Error with an agent-readable message on failure. */
export async function handleAgentRequest(request: AgentRequest, getContext: () => AgentContext): Promise<unknown> {
  const context = getContext()
  switch (request.method) {
    case 'canvasInfo':
      return canvasInfo(context)
    case 'changes':
      return changeSet(context, (request.params as AgentMethods['changes']['params']).since)
    case 'screenshot':
      return screenshot(context, request.params as AgentMethods['screenshot']['params'])
    case 'openBoard': {
      await openBoard(context, (request.params as AgentMethods['openBoard']['params']).path)
      return canvasInfo(getContext())
    }
    default:
      throw new Error(`Unknown request: ${String(request.method)}`)
  }
}
