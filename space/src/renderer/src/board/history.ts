import { isInk, type BoardNode } from '@shared/board-format'

/** How to turn the snapshot above into the one below: nodes at `at` give way to `insert`. A commit changes few nodes, so a step holds few. */
interface Step {
  at: number
  remove: number
  insert: BoardNode[]
}

/** The step that turns `from` into `to`: all between their same start and same end. */
function stepBetween(from: readonly BoardNode[], to: readonly BoardNode[]): Step {
  const shortest = Math.min(from.length, to.length)
  let start = 0
  while (start < shortest && from[start] === to[start]) start++
  let end = 0
  while (end < shortest - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  return { at: start, remove: from.length - start - end, insert: to.slice(start, to.length - end) }
}

/** A stack of snapshots: the newest whole, each one below it as a step from the one above. */
class Snapshots {
  private top: readonly BoardNode[] | null = null
  private below: Step[] = []

  get depth(): number {
    return this.top ? this.below.length + 1 : 0
  }

  push(snapshot: readonly BoardNode[]): void {
    if (this.top) this.below.push(stepBetween(snapshot, this.top))
    this.top = snapshot
  }

  pop(): BoardNode[] | null {
    const snapshot = this.top
    if (!snapshot) return null
    const step = this.below.pop()
    this.top = step ? [...snapshot.slice(0, step.at), ...step.insert, ...snapshot.slice(step.at + step.remove)] : null
    return [...snapshot]
  }

  /** The oldest snapshot goes. */
  dropOldest(): void {
    this.below.shift()
  }

  clear(): void {
    this.top = null
    this.below = []
  }
}

/**
 * Bounded snapshots of a board's nodes. Camera movement never enters this
 * stack. Each step of depth costs what the commit changed, not the whole list of nodes.
 */
export class BoardHistory {
  private past = new Snapshots()
  private future = new Snapshots()

  constructor(private readonly limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('History limit must be a positive integer.')
  }

  private keep(snapshot: readonly BoardNode[]): void {
    this.past.push([...snapshot])
    if (this.past.depth > this.limit) this.past.dropOldest()
  }

  record(snapshot: readonly BoardNode[]): void {
    this.keep(snapshot)
    this.future.clear()
  }

  undo(current: readonly BoardNode[]): BoardNode[] | null {
    const snapshot = this.past.pop()
    if (!snapshot) return null
    this.future.push([...current])
    return snapshot
  }

  redo(current: readonly BoardNode[]): BoardNode[] | null {
    const snapshot = this.future.pop()
    if (!snapshot) return null
    this.keep(current)
    return snapshot
  }

  clear(): void {
    this.past.clear()
    this.future.clear()
  }
}

/** About how many bytes the nodes of a board hold in memory: the points of ink, and the text of the rest. */
export function boardBytes(nodes: readonly BoardNode[]): number {
  let bytes = 0
  for (const node of nodes) {
    if (isInk(node)) bytes += 200 + node.points.length * 48
    else {
      const { text, markup } = node as { text?: unknown; markup?: unknown }
      bytes += 400 + (typeof text === 'string' ? text.length : 0) + (typeof markup === 'string' ? markup.length : 0)
    }
  }
  return bytes
}
