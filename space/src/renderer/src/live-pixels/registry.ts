import type { LiveNode } from '@shared/board-format'
import type { WorldPointer } from '@shared/world-protocol'
import { scenePlayer } from '../live/player'
import { absNow, itemTime, sceneTimelineOf, seedOf, tickOf, TICK_HZ, type ItemClock, type LiveTimeline, type SceneClock, type SceneView } from './clock'
import type { CanvasSize, HostEvents, LiveFrame, LiveHost, LiveInput } from './host'
import { canvasSyntaxError } from './sandbox'
import { shaderEngine, shaderError, ShaderHost } from './shader'
import { boardSlots, type SlotOwner } from './slots'
import { WorldHost, type WorldHit } from './world/host'
import { createHost, programError, stillAt } from './stills'

/**
 * Live pixel items on the page: their hosts, clocks, visibility, status and
 * resources. The contract of the hosts is in host.ts, the time model in
 * clock.ts.
 *
 * - An item starts its host when a scene that plays it starts (or queues it),
 *   on screen or not, and keeps it while that scene plays or waits. Any
 *   other item starts its host when it comes on screen. A still of an item
 *   without a host comes from a step host (stills.ts).
 * - An item off screen whose scene settled runs nothing; after RELEASE_MS (or
 *   at once when an item on screen needs its slot) its host ends its worker
 *   and frees its GPU contexts. Its element keeps the last picture until a
 *   new host draws.
 * - Canvas and program hosts take slots (slots.ts); an item without one
 *   waits ("waiting") and starts when a slot is free.
 * - The scene clock of an item goes to its host only when it changes: a
 *   pause, a resume, a seek, a new step, the end of the scene. Shaders draw
 *   any time at once. A canvas or program item keeps state, so a jump of its
 *   clock (a seek, a replay from a step) starts a fresh host. A host that
 *   starts while its scene is past its start steps from the scene's start to
 *   the clock's tick on the preview grid, with the scene's params and steps
 *   (as stills do), and then goes live. The last picture shows meanwhile.
 * - A host on screen that does not answer for STALL_MS stops ("stalled"):
 *   its worker ends, its slot is free, its element keeps the last picture.
 *   It starts again when its scene replays, its code or params change, or
 *   the learner double-clicks it.
 * - A lost GPU context starts a fresh host; the third loss in a minute is an
 *   error.
 */

export type LiveState = 'starting' | 'running' | 'paused' | 'waiting' | 'error' | 'stalled'

export interface LiveStatus {
  state: LiveState
  error?: string
  /** Frames drawn since the item appeared on this page. */
  frames: number
  /** Program items: how the item takes pointer input (its program's input(mode)). */
  input?: LiveInput
}

/** A canvas or program host that sends no alive message for this long while on screen is shown as not responding. */
const STALL_MS = 2000
/** A jump forward of the scene clock by more than this (s) is a seek: a canvas or program item starts a fresh host. */
const JUMP_S = 0.25
/** A host that steps to its clock goes live when it is at most this many ticks behind the clock. */
const BEHIND_TICKS = 3
/** A still waits this long for a host that steps to its clock. */
const STEP_WAIT_MS = 5000
/** A host off screen for this long ends (its worker and GPU contexts go). */
const RELEASE_MS = 15000
/** Housekeeping: on-screen size, stalls, releases. */
const HOUSEKEEPING_MS = 250
/** A replaced host shows its last picture until the new one draws, at most this long. */
const SWAP_MS = 3000
/** GPU context losses in LOSS_WINDOW_MS before the item stops with an error. */
const MAX_LOSSES = 3
const LOSS_WINDOW_MS = 60000

// ---------- Playback: params and scene clocks from the player ----------

let playbackParams: ReadonlyMap<string, Record<string, number>> = new Map()
let playbackClocks: ReadonlyMap<string, SceneClock> = new Map()

/**
 * Scene playback (Board, each playback frame): the params each live item
 * shows now, merged over its own, and the scene clock of each item a scene
 * plays. null ends it. An item's host gets a message only when its params or
 * its clock change.
 */
export function setLivePlayback(frame: { overrides: ReadonlyMap<string, { params?: Record<string, number> }>; clocks?: ReadonlyMap<string, SceneClock> } | null): void {
  const clocks = frame?.clocks ?? new Map<string, SceneClock>()
  if (clocks.size || playbackClocks.size) {
    playbackClocks = clocks
    for (const item of items.values()) item.sceneClockChanged(clocks.get(item.id) ?? null)
  }
  const next = new Map<string, Record<string, number>>()
  if (frame) for (const [id, override] of frame.overrides) if (override.params) next.set(id, override.params)
  if (next.size === 0 && playbackParams.size === 0) return
  const before = playbackParams
  playbackParams = next
  for (const item of items.values()) {
    if (before.get(item.id) !== playbackParams.get(item.id)) item.paramsChanged()
  }
}

// ---------- Input: the item the learner entered ----------

let entered: string | null = null
const enteredListeners = new Set<() => void>()

/** The program item that gets the learner's pointer and keys now (input "enter"), or null. */
export function enteredLive(): string | null {
  return entered
}

export function subscribeEntered(listener: () => void): () => void {
  enteredListeners.add(listener)
  return () => enteredListeners.delete(listener)
}

/** Give the learner's input to a program item whose input is "enter" (double-click); null leaves it. Returns whether it entered. A double-click on a stopped item starts it again. */
export function enterLive(id: string | null): boolean {
  const target = id ? items.get(id) : undefined
  if (target?.isStopped) {
    target.retry()
    return false
  }
  const next = target && target.status.input === 'enter' && target.status.state !== 'error' ? id : null
  if (next === entered) return next !== null
  const before = entered ? items.get(entered) : undefined
  entered = next
  before?.setEntered(false)
  target?.setEntered(next !== null)
  for (const listener of enteredListeners) listener()
  return next !== null
}

/** The input mode of a live item: "none" unless its program asked for more. A stopped item takes a double-click ("enter"): it starts again. */
export function liveInput(id: string): LiveInput {
  const item = items.get(id)
  return item?.isStopped ? 'enter' : (item?.status.input ?? 'none')
}

// ---------- Items ----------

// The items outlive a hot reload of this file or of the world files in dev.
const items: Map<string, LiveItem> = (import.meta.hot?.data.items as Map<string, LiveItem> | undefined) ?? new Map()
if (import.meta.hot) import.meta.hot.data.items = items

function pixelSize(element: HTMLElement, w: number, h: number): CanvasSize {
  const rect = element.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  let pw = Math.max(1, Math.round(rect.width * dpr))
  let ph = Math.max(1, Math.round(rect.height * dpr))
  // Never more pixels than the screen shows: a deep zoom into a big item stays affordable.
  const screen = Math.max(1, window.innerWidth * window.innerHeight * dpr * dpr)
  if (pw * ph > screen) {
    const k = Math.sqrt(screen / (pw * ph))
    pw = Math.max(1, Math.round(pw * k))
    ph = Math.max(1, Math.round(ph * k))
  }
  pw = Math.min(pw, 8192)
  ph = Math.min(ph, 8192)
  return { w: Math.max(1e-3, w), h: Math.max(1e-3, h), pw, ph }
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

function paramNames(params: Record<string, number>): string {
  return Object.keys(params).sort().join(',')
}

/** The timeline of an item in the playing scene whose clock it follows (the first scene that plays it, as in player.ts). */
function playingTimeline(id: string): LiveTimeline | null {
  for (const play of scenePlayer.playingScenes()) {
    const timeline = sceneTimelineOf(play, id)
    if (timeline) return timeline
  }
  return null
}

/** The clock of an item that no scene plays: from where its scene ended (LiveNode.rest), else 0, in real time. */
function restClock(node: LiveNode): { clock: ItemClock; scene: SceneView } {
  const rest = node.rest
  const t = rest && Number.isFinite(rest.t) && rest.t >= 0 ? rest.t : 0
  const step = rest && typeof rest.step === 'string' ? rest.step : null
  return { clock: { t, at: absNow(), rate: 1 }, scene: { t, playing: false, active: false, ended: true, step } }
}

/** One live item on the page, driven by its view (LiveView). */
export class LiveItem implements SlotOwner {
  node: LiveNode
  /** Program items: the last report() values. */
  report: unknown = undefined
  status: LiveStatus = { state: 'paused', frames: 0 }
  private seed: number
  private visible = false
  private area = 0
  /** Since when the item is off screen and no scene plays it (performance.now). */
  private restingSince = 0
  private host: LiveHost | null = null
  /** The host while it steps to its clock (hidden; it gets no clock and no params until it goes live), and when it is done. */
  private stepping: { host: LiveHost; done: Promise<void> } | null = null
  /** The host stopped answering and ended: no new host until retry(). */
  private stopped = false
  /** A host that was replaced or released: its element shows its last picture until the next host draws. */
  private leaving: { host: LiveHost; timer: number } | null = null
  private size: CanvasSize = { w: 1, h: 1, pw: 1, ph: 1 }
  private clock: ItemClock
  private scene: SceneView
  private sceneEnd = 0
  private params: Record<string, number>
  private frames = 0
  private frameBase = 0
  private aliveAt = 0
  private contexts = 0
  private losses: number[] = []

  constructor(
    readonly id: string,
    node: LiveNode,
    private container: HTMLElement,
    private onStatus: (status: LiveStatus) => void
  ) {
    this.node = node
    this.seed = seedOf(node)
    this.params = this.currentParams()
    const rest = restClock(node)
    this.clock = rest.clock
    this.scene = rest.scene
    items.set(id, this)
    const clock = playbackClocks.get(id)
    if (clock) this.sceneClockChanged(clock)
    ensureHousekeeping()
  }

  private currentParams(): Record<string, number> {
    const override = playbackParams.get(this.id)
    return override ? { ...this.node.params, ...override } : this.node.params
  }

  private setStatus(state: LiveState, error?: string, input = this.status.input): void {
    const frames = this.frameBase + this.frames
    if (this.status.state === state && this.status.error === error && this.status.input === input) {
      this.status = { ...this.status, frames }
      return
    }
    this.status = { state, error, frames, input }
    this.onStatus(this.status)
    if (entered === this.id && (state === 'error' || input !== 'enter')) enterLive(null)
  }

  private shownState(): LiveState {
    return this.visible ? 'running' : 'paused'
  }

  // ----- Hosts -----

  /** An item wants a host while it is on screen or a scene plays it (or waits to play it). */
  private wantsHost(): boolean {
    return this.visible || this.scene.active
  }

  /** The host runs frames while the window shows and the item wants a host. */
  private runs(): boolean {
    return this.wantsHost() && document.visibilityState !== 'hidden'
  }

  /** Wanted with no host: start one (canvas and program items need a slot first). */
  private ensureHost(): void {
    if (this.host || !this.wantsHost() || this.status.state === 'error' || this.stopped) return
    if (this.node.mode === 'shader' || this.node.mode === 'world' || boardSlots.request(this)) this.startHost()
    else this.setStatus('waiting')
  }

  /** The host steps to its clock now: the timeline of its scene, or null (it starts live at the clock's tick). */
  private stepTimeline(): LiveTimeline | null {
    if (this.node.mode === 'shader' || !this.scene.active || tickOf(itemTime(this.clock)) === 0) return null
    return playingTimeline(this.id)
  }

  /** The current host steps to its clock. */
  private get catchingUp(): boolean {
    return this.host !== null && this.stepping?.host === this.host
  }

  private startHost(): void {
    this.size = pixelSize(this.container, this.node.w, this.node.h)
    const timeline = this.stepTimeline()
    this.frameBase += this.frames
    this.frames = 0
    this.contexts = 0
    this.aliveAt = performance.now()
    this.report = undefined
    if (this.status.state !== 'error') this.setStatus('starting')
    let host: LiveHost | null = null
    const current = (): boolean => host !== null && this.host === host
    const events: HostEvents = {
      onAlive: (frames) => {
        if (!current()) return
        this.frames = frames
        this.aliveAt = performance.now()
        // The new host drew: the one it replaces goes (a stepping host shows when it reaches its clock).
        if (frames > 0 && !this.catchingUp) this.endLeaving()
        if (this.status.state === 'starting' || this.status.state === 'stalled' || this.status.state === 'waiting') this.setStatus(this.shownState())
        else this.status = { ...this.status, frames: this.frameBase + frames }
      },
      // A stepping host that moves on is alive.
      onProgress: () => {
        if (current()) this.aliveAt = performance.now()
      },
      onError: (message) => {
        if (!current()) return
        this.endLeaving()
        this.setStatus('error', message)
        boardSlots.release(this)
      },
      onLost: () => {
        if (current()) this.lost()
      },
      onGpu: (contexts) => {
        if (!current()) return
        this.contexts = contexts
        boardSlots.weigh(this, contexts)
      },
      onInput: (mode) => {
        if (current()) this.setStatus(this.status.state, this.status.error, mode)
      },
      onReport: (values) => {
        if (current()) this.report = values
      },
      onEscape: () => {
        if (entered === this.id) enterLive(null)
      }
    }
    host = createHost(
      this.node.mode,
      {
        id: this.id,
        code: this.node.code,
        data: this.node.data,
        pins: this.node.pins,
        seed: this.seed,
        size: this.size,
        // Stepping: the item's own params under the timeline's, as in a preview.
        params: timeline ? this.node.params : this.params,
        mode: timeline ? 'step' : 'live',
        from: timeline ? 0 : tickOf(itemTime(this.clock)),
        clock: this.clock,
        scene: this.scene,
        timeline,
        visible: this.runs()
      },
      events,
      this.container
    )
    this.host = host
    if (timeline) this.stepping = { host, done: this.stepToClock(host) }
    if (this.node.mode === 'shader') ensureLoop()
  }

  /**
   * A stepping host runs every tick from the scene's start to the clock's
   * tick (again while the clock moves on), then shows and goes live. The
   * picture of the host before it shows meanwhile.
   */
  private async stepToClock(host: LiveHost): Promise<void> {
    const element = host.element
    if (element) element.style.opacity = '0'
    let to = tickOf(itemTime(this.clock))
    for (;;) {
      const at = await host.advance(to, false)
      if (!at || this.host !== host) return
      to = tickOf(itemTime(this.clock))
      if (to - at.tick <= BEHIND_TICKS) break
    }
    this.stepping = null
    host.goLive(this.clock, this.scene, this.params)
    if (element) element.style.opacity = ''
    this.endLeaving()
  }

  /** End a replaced or stopped host: it shows its last picture until the next host draws (at most `ms`; 0: no limit). A stepping host shows nothing, so the picture before it stays. */
  private retire(host: LiveHost, ms: number): void {
    if (this.stepping?.host === host) {
      this.stepping = null
      host.dispose()
    } else this.keepLeaving(host, ms)
  }

  /** A replaced host ends now; its element shows the last picture until the new host draws (at most SWAP_MS). */
  private keepLeaving(host: LiveHost, ms: number): void {
    this.endLeaving()
    host.stop()
    this.leaving = { host, timer: ms ? window.setTimeout(() => this.endLeaving(), ms) : 0 }
  }

  private endLeaving(): void {
    if (!this.leaving) return
    clearTimeout(this.leaving.timer)
    this.leaving.host.dispose()
    this.leaving = null
  }

  /** A fresh host at the clock now (a jump of the clock, a lost context). The old one shows until the new one draws, or until a stepping host reaches its clock. */
  private restart(): void {
    const old = this.host
    this.host = null
    if (old) this.retire(old, this.stepTimeline() ? 0 : SWAP_MS)
    if (this.wantsHost()) this.startHost()
  }

  /** End the host (its worker and GPU contexts); its element keeps the last picture until the next host draws. */
  private release(): void {
    const old = this.host
    this.host = null
    boardSlots.release(this)
    if (old) this.retire(old, 0)
    if (this.status.state !== 'error') this.setStatus('paused')
  }

  /** The host does not answer: end it and free its slot. Its element keeps the last picture; no new host starts until retry(). */
  private stall(): void {
    this.stopped = true
    this.release()
    this.setStatus('stalled')
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** Start a stopped item again (a double-click, a replay, new code or params). */
  retry(): void {
    if (!this.stopped) return
    this.stopped = false
    this.setStatus(this.shownState())
    this.ensureHost()
    this.host?.run(this.runs())
  }

  private lost(): void {
    const now = performance.now()
    this.losses = [...this.losses.filter((at) => now - at < LOSS_WINDOW_MS), now]
    if (this.losses.length >= MAX_LOSSES) {
      this.setStatus('error', `The GPU context was lost ${MAX_LOSSES} times in a minute.`)
      this.release()
      return
    }
    this.restart()
  }

  // ----- Slots (slots.ts) -----

  /** On screen: its area; off screen in a scene that plays or waits: 0.5 (never evicted for others); else 0. */
  priority(): number {
    return this.visible ? Math.max(1, this.area) : this.scene.active ? 0.5 : 0
  }

  grant(): void {
    if (this.host || !this.wantsHost() || this.status.state === 'error' || this.stopped) {
      boardSlots.release(this)
      return
    }
    this.startHost()
  }

  evict(): void {
    this.release()
  }

  // ----- Clock and params -----

  /** The scene clock of this item now (each playback frame), or null when no scene plays it. */
  sceneClockChanged(clock: SceneClock | null): void {
    const now = absNow()
    const predicted = itemTime(this.clock, now)
    if (clock) {
      const rate = clock.playing ? 1 : 0
      this.sceneEnd = clock.end
      // The same clock as the item has (it moves on by itself): nothing to send.
      if (this.scene.active && rate === this.clock.rate && clock.step === this.scene.step && Math.abs(clock.t - predicted) < 1 / TICK_HZ) return
      // A seek or a replay: back in time, or forward by more than the clock moves by itself.
      const jump = clock.t < predicted - 2 / TICK_HZ || clock.t > predicted + JUMP_S
      this.clock = { t: clock.t, at: now, rate }
      const starts = !this.scene.active
      this.scene = { t: clock.t, playing: clock.playing, active: true, ended: false, step: clock.step }
      if ((jump || starts) && this.stopped) this.retry()
      // A failed world stays stopped: a hung world would hang every world again.
      else if (jump && this.host && this.node.mode !== 'shader' && !(this.node.mode === 'world' && this.status.state === 'error')) this.restart()
      else this.followClock()
      // Its scene plays or waits: the host starts now, on screen or not, and stays until the scene settles.
      if (starts) this.wantChanged()
    } else if (this.scene.active) {
      // The scene ended or stopped: item time runs on in real time; the scene rests at its end.
      this.clock = { t: predicted, at: now, rate: 1 }
      this.scene = { t: this.sceneEnd, playing: false, active: false, ended: true, step: this.scene.step }
      this.followClock()
      this.wantChanged()
    }
  }

  /** Visibility or the scene changed: start the host, run it or not, and note when the item began to rest. */
  private wantChanged(): void {
    if (this.wantsHost()) this.ensureHost()
    else {
      this.restingSince = performance.now()
      if (!this.host) boardSlots.release(this)
    }
    this.host?.run(this.runs())
  }

  private followClock(): void {
    // A stepping host reads the clock when it goes live.
    if (!this.catchingUp) this.host?.follow(this.clock, this.scene)
    if (this.node.mode === 'shader') ensureLoop()
  }

  paramsChanged(): void {
    const next = this.currentParams()
    if (sameParams(next, this.params)) return
    this.params = next
    if (!this.catchingUp) this.host?.setParams(next)
    if (this.node.mode === 'shader') ensureLoop()
  }

  /** The view got a new node object. */
  update(node: LiveNode): void {
    const before = this.node
    this.node = node
    const seed = seedOf(node)
    const restart =
      node.mode !== before.mode ||
      node.code !== before.code ||
      seed !== this.seed ||
      (node.mode === 'shader' && paramNames(node.params) !== paramNames(before.params)) ||
      (node.mode === 'world' && JSON.stringify(node.data) !== JSON.stringify(before.data))
    if (restart) {
      this.seed = seed
      this.params = this.currentParams()
      this.endLeaving()
      this.host?.dispose()
      this.host = null
      this.stepping = null
      this.stopped = false
      boardSlots.release(this)
      this.setStatus('paused', undefined, undefined)
      this.ensureHost()
      return
    }
    if (node.pins !== before.pins) this.world?.setPins(node.pins ?? [])
    if (node.w !== before.w || node.h !== before.h) this.measure()
    if (node.params !== before.params) {
      this.paramsChanged()
      this.retry()
    }
  }

  setEntered(on: boolean): void {
    this.host?.setEntered(on)
  }

  // ----- Visibility -----

  setVisible(visible: boolean, area: number): void {
    this.area = visible ? area : 0
    if (visible === this.visible) return
    this.visible = visible
    if (visible) this.measure()
    this.wantChanged()
    this.aliveAt = performance.now()
    if (this.status.state === 'running' || this.status.state === 'paused' || (this.status.state === 'waiting' && !visible)) this.setStatus(this.shownState())
    if (visible && this.node.mode === 'shader') ensureLoop()
  }

  /** The window was hidden or shown: hosts run only while it shows. */
  windowShown(shown: boolean): void {
    this.host?.run(shown && this.wantsHost())
    this.aliveAt = performance.now()
    if (shown && this.node.mode === 'shader') ensureLoop()
  }

  get isVisible(): boolean {
    return this.visible
  }

  private measure(): void {
    const next = pixelSize(this.container, this.node.w, this.node.h)
    const s = this.size
    if (next.pw === s.pw && next.ph === s.ph && next.w === s.w && next.h === s.h) return
    this.size = next
    this.host?.resize(next)
    if (this.node.mode === 'shader') ensureLoop()
  }

  /** Housekeeping (every HOUSEKEEPING_MS): the on-screen size, stalls and releases. */
  housekeep(now: number): void {
    if (this.visible) this.measure()
    if (!this.host || this.node.mode === 'shader' || this.node.mode === 'world') return
    const shown = this.visible && document.visibilityState !== 'hidden'
    if (shown && this.status.state !== 'error' && now - this.aliveAt > STALL_MS) this.stall()
    // Off screen: a host ends RELEASE_MS after its scene settled (never while it plays or waits).
    else if (!this.visible && !this.scene.active && now - this.restingSince > RELEASE_MS) this.release()
  }

  /** One display frame for a shader item: true while it wants more. */
  shaderFrame(): boolean {
    return this.host instanceof ShaderHost ? this.host.frame() : false
  }

  /** The world's host, when this item is a running world. */
  get world(): WorldHost | null {
    return this.host instanceof WorldHost && this.status.state !== 'error' ? this.host : null
  }

  /** The current pixels and their tick (agent screenshots); a step host makes them when the item has no host. Null when there is no picture. */
  async still(): Promise<LiveFrame | null> {
    // A stopped item does not answer: a step host would hang the same way.
    if (this.status.state === 'error' || this.stopped) return null
    if (this.catchingUp && this.stepping) {
      // A stepping host shows its picture when it reaches its clock.
      await Promise.race([this.stepping.done, new Promise((resolve) => window.setTimeout(resolve, STEP_WAIT_MS))])
      if (this.catchingUp) return null
    }
    if (this.host) {
      const frame = await this.host.capture()
      if (frame?.url) return frame
    }
    const size = pixelSize(this.container, this.node.w, this.node.h)
    return stillAt(this.node, this.params, itemTime(this.clock), size.pw / size.w)
  }

  /** For dev checks. */
  get resources(): { host: boolean; contexts: number } {
    return { host: this.host !== null, contexts: this.host ? this.contexts : 0 }
  }

  dispose(): void {
    if (entered === this.id) enterLive(null)
    this.endLeaving()
    this.host?.dispose()
    this.host = null
    this.stepping = null
    boardSlots.release(this)
    if (items.get(this.id) === this) items.delete(this.id)
  }
}

// ---------- Shader frames and housekeeping ----------

let loop = 0

/** The display-frame loop of shader items: it runs while a shader on screen has moving time or a picture to draw. */
function ensureLoop(): void {
  if (loop || document.visibilityState === 'hidden') return
  loop = requestAnimationFrame(() => {
    loop = 0
    let more = false
    for (const item of items.values()) if (item.isVisible && item.shaderFrame()) more = true
    if (more) ensureLoop()
  })
}

shaderEngine.subscribe(() => ensureLoop())

let housekeeping = 0

function ensureHousekeeping(): void {
  if (housekeeping) return
  housekeeping = window.setInterval(() => {
    if (!items.size) {
      clearInterval(housekeeping)
      housekeeping = 0
      return
    }
    const now = performance.now()
    for (const item of items.values()) item.housekeep(now)
  }, HOUSEKEEPING_MS)
}

// ---------- Visibility ----------

let observer: IntersectionObserver | null = null
const byElement = new WeakMap<Element, LiveItem>()

export function observe(element: HTMLElement, item: LiveItem): void {
  // A world reaches past its rect, and the board clips its elements: the board's paint places worlds (nearWorlds).
  if (item.node.mode === 'world') return
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) byElement.get(entry.target)?.setVisible(entry.isIntersecting, entry.intersectionRect.width * entry.intersectionRect.height)
      boardSlots.grantWaiting()
    },
    { root: null, rootMargin: '64px', threshold: [0, 0.25, 0.5, 0.75, 1] }
  )
  byElement.set(element, item)
  observer.observe(element)
}

/**
 * In the board's paint: each world is wanted while its rect is within one
 * screen of the view, so what it reaches is there when it comes into view.
 */
export function nearWorlds(view: { x: number; y: number; width: number; height: number }, rectOf: (id: string) => { x: number; y: number; w: number; h: number } | null): void {
  for (const item of items.values()) {
    if (item.node.mode !== 'world') continue
    const rect = rectOf(item.id)
    if (!rect) continue
    const near = rect.x < view.x + view.width * 2 && rect.x + rect.w > view.x - view.width && rect.y < view.y + view.height * 2 && rect.y + rect.h > view.y - view.height
    item.setVisible(near, rect.w * rect.h)
  }
}

// ---------- Touch: the board's side of a world's input ----------

/** The running worlds, the top one first. */
function worldItems(): LiveItem[] {
  return [...items.values()].filter((item) => item.world && item.isVisible).sort((a, b) => b.node.z - a.node.z)
}

/** The worlds that a press can reach: input "direct", or the world the learner entered. */
export function pressWorlds(): string[] {
  return worldItems()
    .filter((item) => item.status.input === 'direct' || enteredLive() === item.id)
    .map((item) => item.id)
}

/** The worlds that take a double-click (input "enter"). */
export function enterWorlds(): string[] {
  return worldItems()
    .filter((item) => item.status.input === 'enter')
    .map((item) => item.id)
}

/** The worlds that keep marks: those that take no input. */
export function markWorlds(): string[] {
  return worldItems()
    .filter((item) => (item.status.input ?? 'none') === 'none')
    .map((item) => item.id)
}

/** The top world with something at a board point, within `ms`; null: none. */
export async function pickWorlds(ids: readonly string[], x: number, y: number, ms: number): Promise<{ id: string; hit: WorldHit } | null> {
  const hits = await Promise.all(ids.map((id) => items.get(id)?.world?.pick(x, y, ms) ?? Promise.resolve(null)))
  const at = hits.findIndex(Boolean)
  return at < 0 ? null : { id: ids[at], hit: hits[at] as WorldHit }
}

/** A pointer event for one world, while it listens. */
export function sendWorldPointer(id: string, event: WorldPointer): void {
  const world = items.get(id)?.world
  if (world?.wants.pointer) world.pointer(event)
}

export function wantsPointerMoves(): boolean {
  return [...items.values()].some((item) => item.world?.wants.pointer)
}

/** A board-wide move for every world that listens. */
export function moveWorlds(event: WorldPointer, except: string | null): void {
  for (const item of items.values()) if (item.world?.wants.pointer && item.id !== except) item.world.pointer(event)
}

/** The world the learner entered, while it takes the pointer. */
export function enteredWorld(): string | null {
  return entered && items.get(entered)?.world ? entered : null
}

/** The board's ink for every world that listens. */
export function sendWorldInk(inks: ReadonlyArray<{ node: { id: string; points: ReadonlyArray<readonly number[]> }; offset: readonly [number, number] }>): void {
  const list = inks.map(({ node, offset }) => ({
    id: node.id,
    node,
    at: offset,
    points: () => node.points.map((p): [number, number, number] => [p[0] + offset[0], p[1] + offset[1], p[2] ?? 0.5])
  }))
  for (const item of items.values()) if (item.world?.wants.ink) item.world.sendInk(list)
}

/** The names of a world's published parts, from its last picture. */
export function liveParts(id: string): string[] | null {
  return items.get(id)?.world?.parts ?? null
}

export function unobserve(element: HTMLElement): void {
  observer?.unobserve(element)
  byElement.delete(element)
}

document.addEventListener('visibilitychange', () => {
  const shown = document.visibilityState !== 'hidden'
  for (const item of items.values()) item.windowShown(shown)
})

// ---------- For agents, the snapshot path and dev checks ----------

/** The status of a live item on this page, or null when it is not shown. */
export function liveStatus(id: string): LiveStatus | null {
  return items.get(id)?.status ?? null
}

/** The current pixels of a live item and their tick, or null. */
export function liveStill(id: string): Promise<LiveFrame | null> {
  return items.get(id)?.still() ?? Promise.resolve(null)
}

/** One line for list_items: "shader, params k=1 omega=2, code 532 chars, running". */
export function liveSummary(node: LiveNode): string {
  const params = Object.entries(node.params)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ')
  const status = liveStatus(node.id)
  const state = status ? (status.state === 'error' ? 'error (get_item shows it)' : status.state) : 'not shown'
  return `${node.mode}${params ? `, params ${params}` : ''}, code ${node.code.length} chars, ${state}`
}

/** Every live item on the page with its status and resources (dev checks). */
export function liveItems(): Array<{ id: string; mode: string; visible: boolean; host: boolean; contexts: number } & LiveStatus> {
  return [...items.values()].map((item) => ({ id: item.id, mode: item.node.mode, visible: item.isVisible, ...item.resources, ...item.status }))
}

/** Totals for dev checks: items, running hosts, GPU contexts of program code, board slots. */
export function liveResources(): { items: number; hosts: number; workers: number; contexts: number; slots: ReturnType<typeof boardSlots.counts> } {
  const list = liveItems()
  return {
    items: list.length,
    hosts: list.filter((item) => item.host).length,
    workers: list.filter((item) => item.host && item.mode !== 'shader' && item.mode !== 'world').length,
    contexts: list.reduce((sum, item) => sum + item.contexts, 0),
    slots: boardSlots.counts()
  }
}

/** The last report() values of a program item on this page (get_item), or undefined. */
export function liveReport(id: string): unknown {
  return items.get(id)?.report
}

/** Check live code: the shader compile log, the canvas syntax error, or the first error of a program or a world; null when it is fine. */
export async function validateLiveCode(mode: 'shader' | 'canvas' | 'program' | 'world', code: string, params: Record<string, number> = {}, size?: [number, number], data?: unknown): Promise<string | null> {
  if (mode === 'program' || mode === 'world') return programError(mode, code, params, size, data)
  return mode === 'shader' ? shaderError(code, params) : canvasSyntaxError(code)
}
