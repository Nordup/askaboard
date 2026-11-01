import { isInk, type BoardNode } from '@shared/board-format'

/** One place where two lists differ: `remove` nodes at `at` give way to `insert`. */
interface Span {
  at: number
  remove: number
  insert: BoardNode[]
}

/** How to turn the snapshot above into the one below. A commit changes few nodes, so a step holds few, wherever they are in the list. */
type Step = Span[]

/**
 * The spans that turn `from` into `to`: all between their same start and same end, then each
 * run of nodes between nodes that both lists hold in the same order. A node that changed its
 * place in the list makes a wide span, never a wrong one.
 */
function stepBetween(from: readonly BoardNode[], to: readonly BoardNode[]): Step {
  const shortest = Math.min(from.length, to.length)
  let start = 0
  while (start < shortest && from[start] === to[start]) start++
  let end = 0
  while (end < shortest - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  const fromEnd = from.length - end
  const toEnd = to.length - end
  const place = new Map<BoardNode, number>()
  for (let at = start; at < fromEnd; at++) place.set(from[at], at)
  const step: Step = []
  let at = start
  let insert: BoardNode[] = []
  const close = (next: number): void => {
    if (next > at || insert.length) step.push({ at, remove: next - at, insert })
    insert = []
  }
  for (let i = start; i < toEnd; i++) {
    const found = place.get(to[i])
    if (found === undefined || found < at) {
      insert.push(to[i])
      continue
    }
    close(found)
    at = found + 1
  }
  close(fromEnd)
  return step
}

/** `nodes` with a step applied. */
function applyStep(nodes: readonly BoardNode[], step: Step): readonly BoardNode[] {
  const out: BoardNode[] = []
  let at = 0
  for (const span of step) {
    for (; at < span.at; at++) out.push(nodes[at])
    for (const node of span.insert) out.push(node)
    at += span.remove
  }
  for (; at < nodes.length; at++) out.push(nodes[at])
  return out
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
    this.top = step ? applyStep(snapshot, step) : null
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

  eachNode(visit: (node: BoardNode) => void): void {
    this.top?.forEach(visit)
    for (const step of this.below) for (const span of step) span.insert.forEach(visit)
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

  /** Each node the history holds. A node can come more than once. */
  eachNode(visit: (node: BoardNode) => void): void {
    this.past.eachNode(visit)
    this.future.eachNode(visit)
  }
}

/**
 * About how many bytes the nodes of a board hold in memory: the points of ink, and the text of
 * the rest. A move or a restyle makes a new node over the same points and text, and undo holds
 * both nodes: each array of points and each text counts once.
 */
export function boardBytes(nodes: Iterable<BoardNode>): number {
  const counted = new Set<unknown>()
  const once = (value: unknown, size: number): number => {
    if (counted.has(value)) return 0
    counted.add(value)
    return size
  }
  let bytes = 0
  for (const node of nodes) {
    if (isInk(node)) bytes += 200 + once(node.points, node.points.length * 48)
    else {
      const { text, markup } = node as { text?: unknown; markup?: unknown }
      bytes += 400 + (typeof text === 'string' ? once(text, text.length) : 0) + (typeof markup === 'string' ? once(markup, markup.length) : 0)
    }
  }
  return bytes
}
