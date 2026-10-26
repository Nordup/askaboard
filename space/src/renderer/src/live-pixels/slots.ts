/**
 * Limits on live hosts. Each canvas or program host is a worker with its
 * own canvas, and a program can make its own GPU contexts. Chromium keeps
 * only about 16 WebGL contexts per page and loses the oldest one past that,
 * so the page limits how many hosts run at once.
 *
 * Board items (BoardSlots): at most BOARD_WEIGHT units; a host weighs one
 * unit per GPU context its code made, at least one. The rule for who waits:
 * 1. A host off screen whose scene settled (priority 0) gives its slot up
 *    first, when an item that wants one needs it (or after RELEASE_MS:
 *    registry.ts).
 * 2. A host on screen, or of a scene that plays or waits, keeps its slot.
 * 3. A waiting item gets the next free slot: on screen first (the larger
 *    area first), then the items of a playing scene, then the earlier request.
 * Shader items need no slot: they share one context (shader.ts).
 *
 * Step hosts (previews, stills, checks) take turns: at most STEP_HOSTS run
 * at once, in the order they asked.
 */

export const BOARD_WEIGHT = 8
const STEP_HOSTS = 2

export interface SlotOwner {
  /** Area on screen in px; 0.5 off screen in a scene that plays or waits; 0 otherwise. */
  priority(): number
  /** The slot is the owner's now. */
  grant(): void
  /** Give the slot back now (the owner releases its host). */
  evict(): void
}

interface Holder {
  owner: SlotOwner
  weight: number
}

class BoardSlots {
  private holders = new Map<SlotOwner, Holder>()
  private waiting: Array<{ owner: SlotOwner; order: number }> = []
  private order = 0

  private used(): number {
    let sum = 0
    for (const holder of this.holders.values()) sum += holder.weight
    return sum
  }

  has(owner: SlotOwner): boolean {
    return this.holders.has(owner)
  }

  /** Ask for a slot: granted now (true), or the owner waits for grant(). */
  request(owner: SlotOwner): boolean {
    if (this.holders.has(owner)) return true
    if (this.fits(owner)) {
      this.holders.set(owner, { owner, weight: 1 })
      return true
    }
    if (!this.waiting.some((entry) => entry.owner === owner)) this.waiting.push({ owner, order: this.order++ })
    return false
  }

  /** Off-screen holders (not `keep`) give their slots up until `extra` more units fit. True when they fit. */
  private makeRoom(extra: number, keep: SlotOwner): boolean {
    for (const holder of [...this.holders.values()]) {
      if (this.used() + extra <= BOARD_WEIGHT) break
      if (holder.owner !== keep && holder.owner.priority() <= 0) {
        this.holders.delete(holder.owner)
        holder.owner.evict()
      }
    }
    return this.used() + extra <= BOARD_WEIGHT
  }

  /** Room for one more unit for `asker`: off-screen holders make room only for an owner on screen. */
  private fits(asker: SlotOwner): boolean {
    if (this.used() + 1 <= BOARD_WEIGHT) return true
    return asker.priority() > 0 && this.makeRoom(1, asker)
  }

  /** A holder's code made GPU contexts: it weighs one unit per context; off-screen holders make room (a holder on screen is never stopped). */
  weigh(owner: SlotOwner, contexts: number): void {
    const holder = this.holders.get(owner)
    if (!holder) return
    holder.weight = Math.max(1, contexts)
    this.makeRoom(0, owner)
  }

  /** The owner leaves: its slot (or its place in the queue) is free. */
  release(owner: SlotOwner): void {
    this.waiting = this.waiting.filter((entry) => entry.owner !== owner)
    if (!this.holders.delete(owner)) return
    this.grantWaiting()
  }

  /** The waiting owners in the order of the rule, granted while they fit. */
  grantWaiting(): void {
    this.waiting.sort((a, b) => b.owner.priority() - a.owner.priority() || a.order - b.order)
    while (this.waiting.length) {
      const next = this.waiting[0]
      if (!this.fits(next.owner)) break
      this.waiting.shift()
      this.holders.set(next.owner, { owner: next.owner, weight: 1 })
      next.owner.grant()
    }
  }

  /** For dev checks: units in use and owners waiting. */
  counts(): { used: number; hosts: number; waiting: number } {
    return { used: this.used(), hosts: this.holders.size, waiting: this.waiting.length }
  }
}

export const boardSlots = new BoardSlots()

let stepRunning = 0
const stepQueue: Array<() => void> = []

/** Run `work` with a step host's turn: at most STEP_HOSTS at once, in the order asked. */
export async function withStepSlot<T>(work: () => Promise<T>): Promise<T> {
  if (stepRunning >= STEP_HOSTS) await new Promise<void>((resolve) => stepQueue.push(resolve))
  else stepRunning++
  try {
    return await work()
  } finally {
    const next = stepQueue.shift()
    if (next) next()
    else stepRunning--
  }
}
