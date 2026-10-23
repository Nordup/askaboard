import type { BoardItem } from './types'

/**
 * Bounded snapshots of a board's items. Camera movement never enters this
 * stack. Ported from web/src/board/history.ts.
 */
export class BoardHistory {
  private past: BoardItem[][] = []
  private future: BoardItem[][] = []

  constructor(private readonly limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('History limit must be a positive integer.')
  }

  record(snapshot: readonly BoardItem[]): void {
    this.past.push([...snapshot])
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: readonly BoardItem[]): BoardItem[] | null {
    const snapshot = this.past.pop()
    if (!snapshot) return null
    this.future.push([...current])
    return [...snapshot]
  }

  redo(current: readonly BoardItem[]): BoardItem[] | null {
    const snapshot = this.future.pop()
    if (!snapshot) return null
    this.past.push([...current])
    if (this.past.length > this.limit) this.past.shift()
    return [...snapshot]
  }

  clear(): void {
    this.past = []
    this.future = []
  }
}
