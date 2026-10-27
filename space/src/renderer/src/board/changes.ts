import { isInk, type Author, type BoardNode, type Removal, type Revision } from '@shared/board-format'
import type { ItemChange } from '@shared/space-api'
import { inkBounds } from './geometry'
import type { Region } from './types'

/** A removed node, kept in memory so agents can learn what was erased. */
export interface Tombstone {
  id: string
  kind: string
  bounds: Region | null
  seq: number
  /** Who removed it, when known. */
  by?: Author
  /** When it was removed (epoch ms). */
  at: number
  /** The removed node itself, for items that are not ink (their name and kind in the news). */
  node?: BoardNode
}

/** The tombstones a board keeps. Older ones drop off first. */
const MAX_TOMBSTONES = 5000
/** The revisions kept per node. Older ones drop off first. */
const MAX_REVISIONS = 32

/** What a node was at a seq, for telling a change apart (see describeChange). */
export type PriorState =
  /** The node did not exist then: it is new. */
  | { kind: 'new' }
  /** The node was on the board before but removed then: it is back (undo, redo, paste with the same id). */
  | { kind: 'removed' }
  /** The node as it was then. */
  | { kind: 'was'; node: BoardNode }
  /** Not known (the change happened before this log started). */
  | { kind: 'unknown' }

/**
 * The per-board change log: removals, and each node's state before each
 * change (its revisions), so a move can be told from a new item. It lives as
 * long as the app has the folder open; it is not in the board file.
 */
export class ChangeLog {
  private tombstones: Tombstone[] = []
  private revisions = new Map<string, Revision[]>()

  /** Nodes that took a new seq, with their state before. */
  revise(revisions: readonly Revision[], by?: Author): void {
    for (const revision of revisions) {
      const list = this.revisions.get(revision.id) ?? []
      list.push(by ? { ...revision, by } : revision)
      if (list.length > MAX_REVISIONS) list.splice(0, list.length - MAX_REVISIONS)
      this.revisions.set(revision.id, list)
    }
  }

  /** What node `id` was at seq `since`: the state before its first change after it. */
  stateAt(id: string, since: number): PriorState {
    const list = this.revisions.get(id) ?? []
    const index = list.findIndex((revision) => revision.seq > since)
    const first = list[index]
    if (!first) return { kind: 'unknown' }
    if (!first.before) return this.beforeArrival(id, since, index > 0 ? list[index - 1] : null, first.seq)
    // The state before was itself made after `since`, by a change this log does not hold.
    if (first.before.seq > since) return { kind: 'unknown' }
    return { kind: 'was', node: first.before }
  }

  /**
   * What node `id` was at `since`, when its first change after `since` (at
   * seq `arrived`) put it on the board: new, removed (it is back), or there
   * (it was removed and put back after `since`).
   */
  private beforeArrival(id: string, since: number, last: Revision | null, arrived: number): PriorState {
    const removals = this.tombstones.filter((tombstone) => tombstone.id === id)
    // The last removal at or before `since`. If no revision put the node back after it, the node was off the board then.
    const gone = removals.filter((tombstone) => tombstone.seq <= since).at(-1)
    if (gone && (!last || gone.seq > last.seq)) return { kind: 'removed' }
    if (last) return { kind: 'was', node: last.after }
    // No revision before `since`, but a removal between `since` and its return: the node was there at `since`, as it was when removed.
    const between = removals.find((tombstone) => tombstone.seq > since && tombstone.seq < arrived)
    if (between) return between.node ? { kind: 'was', node: between.node } : { kind: 'unknown' }
    return { kind: 'new' }
  }

  /** The last change of node `id` with from < seq <= to (its `after` is the node as it was at `to`), or null when the log holds none. */
  lastRevisionIn(id: string, from: number, to: number): Revision | null {
    const list = this.revisions.get(id) ?? []
    for (let i = list.length - 1; i >= 0; i--) if (list[i].seq > from && list[i].seq <= to) return list[i]
    return null
  }

  /** The removals with from < seq <= to, the last one per id. */
  between(from: number, to: number): Tombstone[] {
    const last = new Map<string, Tombstone>()
    for (const tombstone of this.tombstones) if (tombstone.seq > from && tombstone.seq <= to) last.set(tombstone.id, tombstone)
    return [...last.values()]
  }

  /** How many removals the log holds, and the most it keeps. */
  removalCount(): { held: number; max: number } {
    return { held: this.tombstones.length, max: MAX_TOMBSTONES }
  }

  record(removed: readonly Removal[]): void {
    const at = Date.now()
    for (const { node, seq, bounds, by } of removed) {
      // The Board passes world bounds; a reload from disk does not, so top-level ink falls back to its own position.
      const fallback = isInk(node) ? inkBounds(node, [node.x, node.y]) : null
      this.tombstones.push({ id: node.id, kind: node.kind, bounds: bounds ?? fallback, seq, at, ...(by ? { by } : {}), ...(isInk(node) ? {} : { node }) })
    }
    if (this.tombstones.length > MAX_TOMBSTONES) this.tombstones.splice(0, this.tombstones.length - MAX_TOMBSTONES)
  }

  /** Removals with seq > `seq` (exclusive), newest last. */
  /** The removals after `seq`, the last one per id (an item deleted, put back and deleted again is one removal). */
  after(seq: number): Tombstone[] {
    const last = new Map<string, Tombstone>()
    for (const tombstone of this.tombstones) if (tombstone.seq > seq) last.set(tombstone.id, tombstone)
    return [...last.values()]
  }
}

/** What kind of change made a node's seq new (see describeChange). */
export type ChangeKind = ItemChange

export interface ChangeDescription {
  change: ChangeKind
  /** For a move inside the same parent: the offset in board points. */
  offset?: { dx: number; dy: number }
}

/** The fields that hold an item's content: a change to one of them is an edit. */
const CONTENT_KEYS = new Set(['text', 'markup', 'src', 'code', 'mode', 'params'])
/** The fields that hold an item's place. */
const PLACE_KEYS = new Set(['x', 'y', 'parent', 'z'])

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * How a node changed since a seq: compare it with its state then (from
 * ChangeLog.stateAt). The one description for board news and get_changes.
 */
export function describeChange(node: BoardNode, prior: PriorState): ChangeDescription {
  if (prior.kind === 'new') return { change: 'added' }
  if (prior.kind === 'removed') return { change: 'restored' }
  if (prior.kind === 'unknown') return { change: 'changed' }
  const before = prior.node as unknown as Record<string, unknown>
  const now = node as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(before), ...Object.keys(now)])
  keys.delete('seq')
  const differ = [...keys].filter((key) => !same(before[key], now[key]))
  if (!differ.length) return { change: 'unchanged' }
  if (differ.some((key) => CONTENT_KEYS.has(key))) return { change: 'edited' }
  const styleBefore = (before.style ?? {}) as Record<string, unknown>
  const styleNow = (now.style ?? {}) as Record<string, unknown>
  const sized = ['width', 'height'].some((key) => !same(styleBefore[key], styleNow[key]))
  if (differ.includes('points') || differ.includes('w') || differ.includes('h') || sized) return { change: 'resized' }
  if (differ.every((key) => PLACE_KEYS.has(key)) && differ.some((key) => key !== 'z')) {
    if (differ.includes('parent')) return { change: 'moved' }
    const dx = Math.round(Number(now.x) - Number(before.x))
    const dy = Math.round(Number(now.y) - Number(before.y))
    return { change: 'moved', offset: { dx, dy } }
  }
  return { change: 'changed' }
}
