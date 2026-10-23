import { isStroke, type Removal } from '@shared/board-format'
import { strokeBounds } from './geometry'
import type { Region } from './types'

/** A removed item, kept in memory so agents can learn what was erased. */
export interface Tombstone {
  id: string
  bounds: Region | null
  seq: number
}

/** The tombstones a board keeps. Older ones drop off first. */
const MAX_TOMBSTONES = 5000

/**
 * The per-board removal log. It lives as long as the app has the folder
 * open; it is not in the board file. The items on the board carry their own
 * seq, so added and changed items need no log.
 */
export class ChangeLog {
  private tombstones: Tombstone[] = []

  record(removed: readonly Removal[]): void {
    for (const { item, seq } of removed) {
      this.tombstones.push({ id: item.id, bounds: isStroke(item) ? strokeBounds(item) : null, seq })
    }
    if (this.tombstones.length > MAX_TOMBSTONES) this.tombstones.splice(0, this.tombstones.length - MAX_TOMBSTONES)
  }

  /** Removals with seq > `seq` (exclusive), newest last. */
  after(seq: number): Tombstone[] {
    return this.tombstones.filter((tombstone) => tombstone.seq > seq)
  }
}
