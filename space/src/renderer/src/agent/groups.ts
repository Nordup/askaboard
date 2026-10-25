import { isInk, type Author } from '@shared/board-format'
import type { LiveBoardState } from '../board/Board'
import { buildIndex, parentKey, ROOT } from '../board/scene'
import type { InkNode, LayoutBox, Region } from '../board/types'

/**
 * Ink groups: the learner's strokes clustered by distance and time, so an
 * agent can say "g3" instead of coordinates. Ids are stable for the board
 * session (the tracker lives as long as the app window):
 *
 * - A group keeps its id while it grows or shrinks.
 * - Groups that merge keep the older (lower) id.
 * - A group that splits: the part with most of its strokes keeps the id.
 * - Ids are never reused.
 *
 * Strokes cluster only with strokes of the same parent (top level or one
 * frame) and the same author. Agent ink from one scene ink object is "pinned":
 * it forms its own group, so a circle and a tick stay separate marks.
 */

export interface InkGroup {
  id: string
  author: Author
  /** The frame the strokes belong to, or ROOT ("") for top level. */
  parent: string
  strokes: string[]
  bounds: Region
  /** The highest seq among the strokes (last changed). */
  seq: number
}

/** Strokes this close (board points) belong together, before scaling. */
const LINK_GAP = 24
/** Strokes drawn within this time chain more easily. */
const LINK_TIME_MS = 4000
/** Without times (strokes from an earlier session): strokes this close in seq count as close in time. */
const SEQ_NEIGHBOURS = 2
/** The gap grows by this factor for strokes drawn close in time. */
const TIME_BONUS = 2
/** The pen width that LINK_GAP is tuned for (board points, "medium"). */
const BASE_WIDTH = 3.5
const HIGHLIGHTER_SCALE = 4

export const isGroupId = (id: unknown): id is string => typeof id === 'string' && /^g\d+$/.test(id)

function separation(a: Region, b: Region): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width))
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
  return Math.hypot(dx, dy)
}

const penWidth = (stroke: InkNode): number => (stroke.tool === 'highlighter' ? stroke.width / HIGHLIGHTER_SCALE : stroke.width)

function union(boxes: readonly Region[]): Region {
  let x = Infinity
  let y = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const box of boxes) {
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { x, y, width: right - x, height: bottom - y }
}

interface Item {
  stroke: InkNode
  box: LayoutBox
  time: number | undefined
}

/** Single-link clustering by distance (scaled by stroke width) and time. */
function cluster(items: Item[]): Item[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      const scale = Math.max(1, Math.min(3, Math.max(penWidth(a.stroke), penWidth(b.stroke)) / BASE_WIDTH))
      // Times are known for strokes of this app session; for older ones, adjacent seqs stand in (drawn one after the other).
      const close =
        a.time !== undefined && b.time !== undefined
          ? Math.abs(a.time - b.time) <= LINK_TIME_MS
          : a.time === undefined && b.time === undefined && Math.abs(a.stroke.seq - b.stroke.seq) <= SEQ_NEIGHBOURS
      const gap = LINK_GAP * scale * (close ? TIME_BONUS : 1)
      if (separation(a.box, b.box) <= gap) parent[find(i)] = find(j)
    }
  }
  const out = new Map<number, Item[]>()
  items.forEach((item, i) => {
    const root = find(i)
    const list = out.get(root)
    if (list) list.push(item)
    else out.set(root, [item])
  })
  return [...out.values()]
}

const idNumber = (id: string): number => Number(id.slice(1))

export class InkGroupTracker {
  private next = 1
  /** Spatial groups from the last compute: id → stroke ids. */
  private previous = new Map<string, Set<string>>()
  /** Agent groups from scene ink objects: id → stroke ids. Kept when empty, so redo brings the id back. */
  private pinned = new Map<string, Set<string>>()

  /** A new group id for strokes an agent just drew. */
  pin(strokeIds: readonly string[]): string {
    const id = `g${this.next++}`
    this.pinned.set(id, new Set(strokeIds))
    return id
  }

  /** An agent group gets more strokes (a scene redrew its ink object); returns its id. */
  repin(id: string, strokeIds: readonly string[]): string {
    const set = this.pinned.get(id) ?? new Set<string>()
    for (const strokeId of strokeIds) set.add(strokeId)
    this.pinned.set(id, set)
    return id
  }

  compute(state: LiveBoardState): InkGroup[] {
    const index = buildIndex(state.nodes)
    const layout = state.layout()
    const items = new Map<string, Item>()
    for (const node of state.nodes) {
      if (!isInk(node)) continue
      const box = layout.get(node.id)
      if (box) items.set(node.id, { stroke: node, box, time: state.changedAt(node.id) })
    }
    const result: InkGroup[] = []
    const make = (id: string, members: Item[]): InkGroup => ({
      id,
      author: members[0].stroke.author,
      parent: parentKey(members[0].stroke, index.byId),
      strokes: members.map((item) => item.stroke.id),
      bounds: union(members.map((item) => item.box)),
      seq: Math.max(...members.map((item) => item.stroke.seq))
    })

    // 1. Pinned agent groups.
    const taken = new Set<string>()
    for (const [id, ids] of this.pinned) {
      const members = [...ids].map((strokeId) => items.get(strokeId)).filter((item): item is Item => !!item)
      for (const item of members) taken.add(item.stroke.id)
      if (members.length) result.push(make(id, members))
    }

    // 2. Everything else, clustered per parent and author.
    const buckets = new Map<string, Item[]>()
    for (const item of items.values()) {
      if (taken.has(item.stroke.id)) continue
      const key = `${parentKey(item.stroke, index.byId) || ROOT}\u0000${item.stroke.author}`
      const list = buckets.get(key)
      if (list) list.push(item)
      else buckets.set(key, [item])
    }
    const clusters = [...buckets.values()].flatMap(cluster)

    // 3. Keep ids: older groups choose first, each takes the cluster with most of its strokes.
    const pairs: { id: string; cluster: number; shared: number }[] = []
    clusters.forEach((members, i) => {
      const counts = new Map<string, number>()
      for (const item of members) {
        for (const [id, ids] of this.previous) if (ids.has(item.stroke.id)) counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      for (const [id, shared] of counts) pairs.push({ id, cluster: i, shared })
    })
    pairs.sort((a, b) => idNumber(a.id) - idNumber(b.id) || b.shared - a.shared)
    const assigned = new Map<number, string>()
    const used = new Set<string>()
    for (const pair of pairs) {
      if (used.has(pair.id) || assigned.has(pair.cluster)) continue
      assigned.set(pair.cluster, pair.id)
      used.add(pair.id)
    }
    // New clusters get new ids in drawing order (lowest seq first).
    const fresh = clusters
      .map((members, i) => ({ i, seq: Math.min(...members.map((item) => item.stroke.seq)) }))
      .filter((entry) => !assigned.has(entry.i))
      .sort((a, b) => a.seq - b.seq)
    for (const entry of fresh) assigned.set(entry.i, `g${this.next++}`)

    this.previous = new Map()
    clusters.forEach((members, i) => {
      const id = assigned.get(i) as string
      this.previous.set(id, new Set(members.map((item) => item.stroke.id)))
      result.push(make(id, members))
    })
    return result.sort((a, b) => idNumber(a.id) - idNumber(b.id))
  }
}

/** One tracker per board path, for the app session. */
const trackers = new Map<string, InkGroupTracker>()

export function trackerFor(path: string): InkGroupTracker {
  let tracker = trackers.get(path)
  if (!tracker) {
    tracker = new InkGroupTracker()
    trackers.set(path, tracker)
  }
  return tracker
}
