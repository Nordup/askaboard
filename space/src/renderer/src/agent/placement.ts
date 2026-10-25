import { isInk, type BoardNode } from '@shared/board-format'
import type { BoardHandle } from '../board/Board'
import { ancestorIds, buildIndex, ROOT, topLevelOf, type SceneIndex } from '../board/scene'
import type { LayoutBox, Region } from '../board/types'
import { isGroupId, type InkGroup } from './groups'

/**
 * Where agent material goes: the board as a scene sees it, the boxes new
 * material must not cover, and an empty place near an anchor (a scene's
 * space(), and html() without a place).
 */

/** The margin space() keeps to everything. */
export const SPACE_MARGIN = 32
/** Margin kept inside the learner's view when a spot must be visible (board points). */
const VIEW_MARGIN = 16

// ---------- The scene an agent tool works on ----------

export interface Scene {
  nodes: readonly BoardNode[]
  index: SceneIndex
  layout: ReadonlyMap<string, LayoutBox>
  groups: InkGroup[]
  groupById: Map<string, InkGroup>
}

export function sceneOf(board: BoardHandle, groups: () => InkGroup[]): Scene {
  const state = board.liveState()
  const list = groups()
  return { nodes: state.nodes, index: buildIndex(state.nodes), layout: state.layout(), groups: list, groupById: new Map(list.map((group) => [group.id, group])) }
}

/** A node or an ink group, by id. */
export type Target = { kind: 'node'; id: string; node: BoardNode; box: Region | null } | { kind: 'group'; id: string; group: InkGroup; box: Region }

export function resolveTarget(s: Scene, id: unknown, what = 'node_id'): Target {
  if (typeof id !== 'string' || !id) throw new Error(`${what} is required.`)
  if (isGroupId(id)) {
    const group = s.groupById.get(id)
    if (!group) throw new Error(`No ink group "${id}" on the open board. get_canvas_info lists the groups.`)
    return { kind: 'group', id, group, box: group.bounds }
  }
  const node = s.index.byId.get(id)
  if (!node) throw new Error(`No node "${id}" on the open board. Call get_tree to see the node ids.`)
  return { kind: 'node', id, node, box: s.layout.get(id) ?? null }
}

// ---------- Geometry ----------

export function overlaps(a: Region, b: Region, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
}

export function inside(box: Region, view: Region): boolean {
  return box.x >= view.x && box.y >= view.y && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height
}

/** The learner's viewport in board points. */
export function viewOf(board: BoardHandle): Region {
  const state = board.liveState()
  const width = state.viewport[0] / state.camera.zoom
  const height = state.viewport[1] / state.camera.zoom
  return { x: state.camera.center[0] - width / 2, y: state.camera.center[1] - height / 2, width, height }
}

function shrink(view: Region, margin: number): Region {
  return { x: view.x + margin, y: view.y + margin, width: view.width - margin * 2, height: view.height - margin * 2 }
}

/**
 * Boxes agent material must not cover: top-level content and the bounds of
 * every ink group (the same boxes the overlap report uses, so a free spot
 * never reports an overlap). Ids in `skip` (and their subtrees) do not count.
 */
export function obstacles(s: Scene, skip: ReadonlySet<string> = new Set()): Region[] {
  const out: Region[] = []
  for (const node of s.index.children.get(ROOT) ?? []) {
    if (skip.has(node.id) || isInk(node)) continue
    const box = s.layout.get(node.id)
    if (box) out.push(box)
  }
  const skipped = (id: string): boolean => {
    if (skip.has(id)) return true
    const node = s.index.byId.get(id)
    return !!node && ancestorIds(node, s.index.byId).some((ancestor) => skip.has(ancestor))
  }
  for (const group of s.groups) {
    const kept = group.strokes.filter((id) => !skipped(id))
    if (!kept.length) continue
    if (kept.length === group.strokes.length) out.push(group.bounds)
    else for (const id of kept) {
      const box = s.layout.get(id)
      if (box) out.push(box)
    }
  }
  return out
}

/** Most grid columns (and rows) nearestFree tries in one area. */
const GRID_CELLS = 200

/**
 * The free top-left inside `area` whose box centre is nearest the anchor's
 * centre. The grid has at most GRID_CELLS × GRID_CELLS candidates; each is
 * tested as it is made, keeping the best so far.
 */
function nearestFree(size: { width: number; height: number }, anchor: Region, blocked: readonly Region[], margin: number, area: Region): { x: number; y: number } | null {
  const spanX = area.width - size.width
  const spanY = area.height - size.height
  if (!(spanX >= 0) || !(spanY >= 0) || !Number.isFinite(spanX) || !Number.isFinite(spanY)) return null
  const step = Math.max(12, Math.min(48, Math.round(Math.max(area.width, area.height) / 160)), Math.max(spanX, spanY) / GRID_CELLS)
  const cx = anchor.x + anchor.width / 2
  const cy = anchor.y + anchor.height / 2
  let best: { x: number; y: number } | null = null
  let bestDistance = Infinity
  for (let x = area.x; x <= area.x + spanX; x += step) {
    for (let y = area.y; y <= area.y + spanY; y += step) {
      const distance = Math.hypot(x + size.width / 2 - cx, y + size.height / 2 - cy)
      if (distance >= bestDistance) continue
      if (blocked.some((box) => overlaps({ x, y, ...size }, box, margin))) continue
      best = { x: Math.round(x), y: Math.round(y) }
      bestDistance = distance
      // No grid point can be much nearer than one step: stop.
      if (distance <= step / 2) return best
    }
  }
  return best
}

/**
 * An empty box of `size` (a scene's space()) nearest the anchor, SPACE_MARGIN from
 * everything. With preferView, spots fully in the learner's view come first.
 */
export function findSpace(
  size: { width: number; height: number },
  anchor: Region,
  blocked: readonly Region[],
  view: Region,
  preferView: boolean
): { x: number; y: number; width: number; height: number; visible: boolean } | null {
  const shown = shrink(view, VIEW_MARGIN)
  const result = (spot: { x: number; y: number }) => ({ ...spot, ...size, visible: inside({ ...spot, ...size }, view) })
  if (preferView && size.width <= shown.width && size.height <= shown.height) {
    const spot = nearestFree(size, anchor, blocked, SPACE_MARGIN, shown)
    if (spot) return result(spot)
  }
  const cx = anchor.x + anchor.width / 2
  const cy = anchor.y + anchor.height / 2
  for (const reach of [800, 2000, 5000]) {
    const half = { w: reach + size.width, h: reach + size.height }
    const spot = nearestFree(size, anchor, blocked, SPACE_MARGIN, { x: cx - half.w, y: cy - half.h, width: half.w * 2, height: half.h * 2 })
    if (spot) return result(spot)
  }
  return null
}

/** Where agent material goes by default: beside `near`, else beside the learner's latest ink, else the view centre. */
export function anchorFor(s: Scene, board: BoardHandle, near: unknown): Region {
  if (typeof near === 'string' && near) {
    const target = resolveTarget(s, near, 'near')
    if (target.box) return target.box
  }
  let latest: BoardNode | null = null
  for (const node of s.nodes) if (isInk(node) && node.author === 'learner' && (!latest || node.seq > latest.seq)) latest = node
  const view = viewOf(board)
  const latestBox = latest ? s.layout.get(latest.id) : undefined
  if (latest && latestBox && overlaps(latestBox, view, 0)) {
    // The learner's work near the latest stroke: its top-level frame when it is inside one, else its ink group.
    const top = topLevelOf(latest, s.index.byId)
    if (top.id !== latest.id) return s.layout.get(top.id) ?? latestBox
    return s.groups.find((group) => group.strokes.includes(latest.id))?.bounds ?? latestBox
  }
  return { x: view.x + view.width / 2 - 1, y: view.y + view.height / 2 - 1, width: 2, height: 2 }
}
