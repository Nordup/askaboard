/**
 * Back and Forward (decision U11): the boards the window showed, in order, as a browser's history.
 * App.tsx owns the one instance. openBoard calls visit() each time the window shows a board, so every
 * open path enters it; Back and Forward move the place first, and the visit of the same path then adds nothing.
 * A path that no longer names a board of the folder stays in the list but is skipped (step()).
 */
export class OpenHistory {
  private entries: string[] = []
  /** The entry the window shows, or -1. */
  private index = -1

  /** The window shows path. Another path than the current entry drops the forward part and adds it. Returns true when the list changed. */
  visit(path: string): boolean {
    if (this.entries[this.index] === path) return false
    this.entries = [...this.entries.slice(0, this.index + 1), path]
    this.index = this.entries.length - 1
    return true
  }

  /**
   * The entry one step Back (-1) or Forward (+1) goes to: the nearest one in that direction that names a board
   * of the folder (exists) and is not the shown board. Null when there is none: the button is disabled.
   */
  step(direction: -1 | 1, exists: (path: string) => boolean, shown: string | null): { index: number; path: string } | null {
    for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) {
      const path = this.entries[index]
      if (path !== shown && exists(path)) return { index, path }
    }
    return null
  }

  /** Back or Forward: the place moves to an entry of step(); the open that follows visits the same path. */
  go(index: number): void {
    if (index >= 0 && index < this.entries.length) this.index = index
  }

  /** A board renamed or moved: its entries follow the new path. */
  rename(from: string, to: string): boolean {
    if (!this.entries.includes(from)) return false
    this.entries = this.entries.map((path) => (path === from ? to : path))
    this.collapse()
    return true
  }

  /** A board deleted: it leaves the list. The place moves to the entry before it. */
  remove(path: string): boolean {
    if (!this.entries.includes(path)) return false
    const before = this.entries.slice(0, this.index + 1).filter((entry) => entry !== path).length
    this.entries = this.entries.filter((entry) => entry !== path)
    this.index = Math.min(before, this.entries.length) - 1
    if (this.index < 0 && this.entries.length) this.index = 0
    this.collapse()
    return true
  }

  /** Another folder: history starts fresh. */
  clear(): boolean {
    if (!this.entries.length) return false
    this.entries = []
    this.index = -1
    return true
  }

  /** Neighbours with the same path (after a remove or a rename) become one entry. */
  private collapse(): void {
    const kept: string[] = []
    let index = -1
    this.entries.forEach((path, at) => {
      if (kept[kept.length - 1] !== path) kept.push(path)
      if (at === this.index) index = kept.length - 1
    })
    this.entries = kept
    this.index = index
  }
}
