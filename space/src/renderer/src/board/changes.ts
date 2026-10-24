import { isInk, type Author, type Removal } from '@shared/board-format'
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
}

/** The tombstones a board keeps. Older ones drop off first. */
const MAX_TOMBSTONES = 5000

/**
 * The per-board removal log. It lives as long as the app has the folder
 * open; it is not in the board file. The nodes on the board carry their own
 * seq, so added and changed nodes need no log.
 */
export class ChangeLog {
  private tombstones: Tombstone[] = []

  record(removed: readonly Removal[]): void {
    const at = Date.now()
    for (const { node, seq, bounds, by } of removed) {
      // The Board passes world bounds; a reload from disk does not, so top-level ink falls back to its own position.
      const fallback = isInk(node) ? inkBounds(node, [node.x, node.y]) : null
      this.tombstones.push({ id: node.id, kind: node.kind, bounds: bounds ?? fallback, seq, at, ...(by ? { by } : {}) })
    }
    if (this.tombstones.length > MAX_TOMBSTONES) this.tombstones.splice(0, this.tombstones.length - MAX_TOMBSTONES)
  }

  /** Removals with seq > `seq` (exclusive), newest last. */
  after(seq: number): Tombstone[] {
    return this.tombstones.filter((tombstone) => tombstone.seq > seq)
  }
}
