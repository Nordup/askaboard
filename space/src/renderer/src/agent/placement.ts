import { isContent, isInk, type BoardNode, type NodeStyle } from '@shared/board-format'
import type { BoardHandle } from '../board/Board'
import { ancestorIds, buildIndex, ROOT, topLevelOf, withDescendants, type SceneIndex } from '../board/scene'
import type { LayoutBox, Region } from '../board/types'
import { isGroupId, type InkGroup } from './groups'

/**
 * Where agent material goes: one module for every tool that places things
 * (create_frame, write_html, duplicate_nodes, move_nodes, draw_ink,
 * find_space) and for the overlap report every write returns.
 */

/** Space kept around agent material when it is placed automatically (board points). */
export const PLACE_GAP = 48
/** The margin find_space keeps to everything. */
export const SPACE_MARGIN = 32
/** The default gap of relative placement. */
export const RELATIVE_GAP = 32
/** Height assumed for a new frame whose height follows its content. */
export const ASSUMED_HEIGHT = 360
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

/** Node ids with ink group ids replaced by their strokes. */
export function expandIds(s: Scene, ids: readonly string[], what = 'node_ids'): string[] {
  const out: string[] = []
  for (const id of ids) {
    const target = resolveTarget(s, id, what)
    if (target.kind === 'group') out.push(...target.group.strokes)
    else out.push(id)
  }
  return [...new Set(out)]
}

// ---------- Geometry ----------

export function overlaps(a: Region, b: Region, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
}

export function inside(box: Region, view: Region): boolean {
  return box.x >= view.x && box.y >= view.y && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height
}

function intersection(a: Region, b: Region): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
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

export function sizeOf(style: NodeStyle, fallback: { width: number; height: number }): { width: number; height: number } {
  const px = (value: string | undefined): number | null => (value && /^-?[\d.]+px$/.test(value.trim()) ? parseFloat(value) : null)
  return { width: px(style.width) ?? fallback.width, height: px(style.height) ?? fallback.height }
}

// ---------- Automatic placement ----------

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
  const shown = view ? shrink(view, VIEW_MARGIN) : null
  const isVisible = (x: number, y: number): boolean => !!shown && inside({ x, y, ...size }, shown)
  if (shown && size.width <= shown.width && size.height <= shown.height) {
    // 1. The usual spots around the anchor, kept only when fully in view.
    for (let step = 0; step < 60; step++) {
      for (const [x, y] of ring(step * 64)) if (isVisible(x, y) && free(x, y)) return { x: Math.round(x), y: Math.round(y), visible: true }
    }
    // 2. Any free spot in view, nearest to the anchor first.
    const spot = nearestFree(size, anchor, blocked, PLACE_GAP, shown)
    if (spot) return { ...spot, visible: true }
  }
  // 3. Outside the view.
  for (let step = 0; step < 60; step++) {
    for (const [x, y] of ring(step * 64)) if (free(x, y)) return { x: Math.round(x), y: Math.round(y), visible: isVisible(x, y) }
  }
  return { x: Math.round(right), y: Math.round(anchor.y), visible: isVisible(right, anchor.y) }
}

/** The free top-left inside `area` whose box centre is nearest the anchor's centre. */
function nearestFree(size: { width: number; height: number }, anchor: Region, blocked: readonly Region[], margin: number, area: Region): { x: number; y: number } | null {
  const step = Math.max(12, Math.min(48, Math.round(Math.max(area.width, area.height) / 160)))
  const cx = anchor.x + anchor.width / 2
  const cy = anchor.y + anchor.height / 2
  const spots: [number, number, number][] = []
  for (let x = area.x; x + size.width <= area.x + area.width; x += step) {
    for (let y = area.y; y + size.height <= area.y + area.height; y += step) {
      spots.push([x, y, Math.hypot(x + size.width / 2 - cx, y + size.height / 2 - cy)])
    }
  }
  spots.sort((a, b) => a[2] - b[2])
  for (const [x, y] of spots) {
    if (!blocked.some((box) => overlaps({ x, y, ...size }, box, margin))) return { x: Math.round(x), y: Math.round(y) }
  }
  return null
}

/**
 * find_space: an empty box of `size` nearest the anchor, SPACE_MARGIN from
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

// ---------- Relative placement ----------

export type Side = 'right_of' | 'left_of' | 'below' | 'above' | 'over'
export const SIDES: readonly Side[] = ['right_of', 'left_of', 'below', 'above', 'over']
export type Align = 'start' | 'center' | 'end'

export interface PlaceSpec {
  side: Side
  target: string
  gap: number
  align: Align
}

/** Read a `place` argument. Returns null when it is absent. */
export function parsePlace(value: unknown): PlaceSpec | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error('place must be an object like {right_of: "g3", gap: 32}.')
  const raw = value as Record<string, unknown>
  const sides = SIDES.filter((side) => typeof raw[side] === 'string' && raw[side])
  if (sides.length !== 1) throw new Error(`place needs exactly one of ${SIDES.join(', ')} with a node or ink group id.`)
  const side = sides[0]
  const gap = raw.gap === undefined ? (side === 'over' ? 0 : RELATIVE_GAP) : Number(raw.gap)
  if (!Number.isFinite(gap)) throw new Error('place.gap must be a number.')
  const align = raw.align === undefined ? (side === 'over' ? 'center' : 'start') : raw.align
  if (align !== 'start' && align !== 'center' && align !== 'end') throw new Error('place.align must be "start", "center" or "end".')
  return { side, target: raw[side] as string, gap, align }
}

const SIDE_WORDS: Record<Side, string> = { right_of: 'right of', left_of: 'left of', below: 'below', above: 'above', over: 'over' }
const NEXT_SIDES: Record<Exclude<Side, 'over'>, Exclude<Side, 'over'>[]> = {
  right_of: ['right_of', 'below', 'left_of', 'above'],
  below: ['below', 'right_of', 'above', 'left_of'],
  left_of: ['left_of', 'below', 'right_of', 'above'],
  above: ['above', 'right_of', 'below', 'left_of']
}
/** How far placement slides along a side to find room (board points). */
const SLIDE_LIMIT = 800
const SLIDE_STEP = 16

function aligned(start: number, length: number, size: number, align: Align): number {
  return align === 'start' ? start : align === 'end' ? start + length - size : start + (length - size) / 2
}

function sideSpot(side: Side, t: Region, size: { width: number; height: number }, gap: number, align: Align): [number, number] {
  switch (side) {
    case 'right_of':
      return [t.x + t.width + gap, aligned(t.y, t.height, size.height, align)]
    case 'left_of':
      return [t.x - gap - size.width, aligned(t.y, t.height, size.height, align)]
    case 'below':
      return [aligned(t.x, t.width, size.width, align), t.y + t.height + gap]
    case 'above':
      return [aligned(t.x, t.width, size.width, align), t.y - gap - size.height]
    case 'over':
      return [aligned(t.x, t.width, size.width, align), aligned(t.y, t.height, size.height, align)]
  }
}

export interface Placed {
  x: number
  y: number
  visible: boolean
  /** A short account for the agent: where it went and why. */
  placed: string
}

/**
 * Place a box beside (or over) a target box. When the spot is taken, slide
 * along that side to the nearest free spot, then try the next sides. `over`
 * never slides: covering the target is the point.
 */
export function placeRelative(spec: PlaceSpec, target: Region, size: { width: number; height: number }, blocked: readonly Region[], view: Region): Placed {
  const round = (x: number, y: number, placed: string): Placed => ({
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    visible: inside({ x, y, ...size }, view),
    placed
  })
  const name = `${SIDE_WORDS[spec.side]} ${spec.target}`
  if (spec.side === 'over') {
    const [x, y] = sideSpot('over', target, size, 0, spec.align)
    return round(x, y, name)
  }
  const margin = Math.min(16, Math.max(0, spec.gap / 2))
  const free = (x: number, y: number): boolean => !blocked.some((box) => overlaps({ x, y, ...size }, box, margin))
  for (const side of NEXT_SIDES[spec.side]) {
    const [bx, by] = sideSpot(side, target, size, spec.gap, spec.align)
    const horizontal = side === 'right_of' || side === 'left_of'
    for (let offset = 0; offset <= SLIDE_LIMIT; offset += SLIDE_STEP) {
      for (const sign of offset ? [1, -1] : [1]) {
        const x = horizontal ? bx : bx + sign * offset
        const y = horizontal ? by + sign * offset : by
        if (!free(x, y)) continue
        const words = [side === spec.side ? name : `${SIDE_WORDS[side]} ${spec.target} (${SIDE_WORDS[spec.side]} was taken)`]
        if (offset) words.push(`slid ${offset} pt ${horizontal ? (sign > 0 ? 'down' : 'up') : sign > 0 ? 'right' : 'left'} to free space`)
        return round(x, y, words.join(', '))
      }
    }
  }
  const [x, y] = sideSpot(spec.side, target, size, spec.gap, spec.align)
  return round(x, y, `${name}; no free spot nearby, so it overlaps (see overlaps)`)
}

// ---------- Overlap report ----------

export interface Overlap {
  id: string
  kind: string
  author: string
  /** How much of that item this one covers, in percent of its area. */
  area_pct: number
}

/** What a written or moved thing is: its world box, and ids that are part of it (never reported). */
export interface Subject {
  box: Region
  own: Set<string>
}

/** A node as an overlap subject: its subtree and its ancestors are part of it. */
export function nodeSubject(s: Scene, id: string): Subject | null {
  const node = s.index.byId.get(id)
  const box = s.layout.get(id)
  if (!node || !box) return null
  return { box, own: new Set([...withDescendants([id], s.index), ...ancestorIds(node, s.index.byId)]) }
}

export function groupSubject(group: InkGroup): Subject {
  return { box: group.bounds, own: new Set(group.strokes) }
}

/** What the subjects now cover: top-level content and ink groups. Never blocks; agents may annotate on purpose. */
export function overlapReport(s: Scene, subjects: readonly (Subject | null)[]): { overlaps: Overlap[]; warnings?: string[] } {
  const found = new Map<string, Overlap>()
  const note = (entry: Overlap): void => {
    const known = found.get(entry.id)
    if (!known || known.area_pct < entry.area_pct) found.set(entry.id, entry)
  }
  for (const subject of subjects) {
    if (!subject) continue
    for (const node of s.index.children.get(ROOT) ?? []) {
      if (!isContent(node) || subject.own.has(node.id)) continue
      const box = s.layout.get(node.id)
      if (!box) continue
      const area = intersection(subject.box, box)
      const pct = area ? Math.round((area / Math.max(1, box.width * box.height)) * 100) : 0
      if (area > 0) note({ id: node.id, kind: node.kind, author: node.author, area_pct: Math.max(1, pct) })
    }
    for (const group of s.groups) {
      if (group.strokes.every((id) => subject.own.has(id))) continue
      const area = intersection(subject.box, group.bounds)
      if (area <= 0) continue
      const pct = Math.round((area / Math.max(1, group.bounds.width * group.bounds.height)) * 100)
      note({ id: group.id, kind: 'ink', author: group.author, area_pct: Math.max(1, pct) })
    }
  }
  const overlaps = [...found.values()].sort((a, b) => b.area_pct - a.area_pct)
  const warnings = overlaps
    .filter((entry) => entry.kind === 'ink' && entry.author === 'learner')
    .map((entry) => `covers learner ink ${entry.id} (${entry.area_pct}% of its box)`)
  return { overlaps, ...(warnings.length ? { warnings } : {}) }
}
