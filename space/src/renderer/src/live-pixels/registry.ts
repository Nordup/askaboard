import { isOldLive, type LiveNode } from '@shared/board-format'
import type { WorldPointer } from '@shared/world-protocol'
import { scenePlayer } from '../live/player'
import { absNow, itemTime, sceneTimelineOf, seedOf, tickOf, TICK_HZ, type ItemClock, type LiveTimeline, type SceneClock, type SceneView } from './clock'
import { stillAt, worldError } from './stills'
import { onWorldsTrust, worldsTrusted } from './trust'
import { WorldHost, type HostEvents, type LiveFrame, type LiveInput, type WorldHit } from './world/host'
import { endWorldWorkers } from './world/surface'

/**
 * The worlds on the page: their hosts, clocks, status and generations. The
 * time model is in clock.ts, the host in world/host.ts.
 *
 * - A world starts its host when a scene that plays it starts (or queues it),
 *   on screen or not, or when its rect comes within one screen of the view
 *   (nearWorlds). It runs ticks while it is wanted and the window shows. Off
 *   screen it keeps its host and its last picture and points. A still of a world
 *   without a host comes from a step host (stills.ts).
 * - The scene clock of a world goes to its host only when it changes: a pause,
 *   a resume, a seek, a new step, the end of the scene. A world keeps state, so
 *   a jump of its clock (a seek, a replay from a step) starts a new generation.
 *   A generation that starts while its scene is past its start steps from the
 *   scene's start to the clock's tick on the preview grid, with the scene's
 *   params and steps (as stills do), and then goes live. The last picture
 *   shows meanwhile.
 * - A lost worker starts a new generation; the third loss in a minute is an
 *   error.
 * - In a folder the learner has not trusted (U19, trust.ts) no world has a
 *   host: its state is 'untrusted' and its view shows a note. Trust starts the
 *   wanted ones at once; the end of trust ends every host and worker.
 */

export type LiveState = 'starting' | 'running' | 'paused' | 'error' | 'untrusted'

/** What agents read about a world in an untrusted folder (list_items, get_item). */
export const UNTRUSTED_NOTE = 'The learner has not trusted this folder, so its worlds do not run. They can trust it from the note at the world or in Settings › Folder.'

export interface LiveStatus {
  state: LiveState
  error?: string
  /** Frames drawn since the world appeared on this page. */
  frames: number
  /** How the world takes pointer input (its code's input(mode)). */
  input?: LiveInput
}

/** A jump forward of the scene clock by more than this (s) is a seek: it starts a new generation. */
const JUMP_S = 0.25
/** A generation that steps to its clock goes live when it is at most this many ticks behind the clock. */
const BEHIND_TICKS = 3
/** A still waits this long for a generation that steps to its clock. */
const STEP_WAIT_MS = 5000
/** A replaced generation shows its last picture until the new one draws, at most this long. */
const SWAP_MS = 3000
/** Worker losses in LOSS_WINDOW_MS before the world stops with an error. */
const MAX_LOSSES = 3
const LOSS_WINDOW_MS = 60000

// ---------- Playback: params and scene clocks from the player ----------

let playbackParams: ReadonlyMap<string, Record<string, number>> = new Map()
let playbackClocks: ReadonlyMap<string, SceneClock> = new Map()

/**
 * Scene playback (Board, each playback frame): the params each world shows
 * now, merged over its own, and the scene clock of each world a scene plays.
 * null ends it. A host gets a message only when its params or clock change.
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

// ---------- Input: the world the learner entered ----------

let entered: string | null = null
const enteredListeners = new Set<() => void>()

/** The world that gets the learner's pointer now (input "enter"), or null. */
export function enteredLive(): string | null {
  return entered
}

export function subscribeEntered(listener: () => void): () => void {
  enteredListeners.add(listener)
  return () => enteredListeners.delete(listener)
}

/** Give the learner's input to a world whose input is "enter"; null leaves it. Returns whether it entered. */
export function enterLive(id: string | null): boolean {
  const target = id ? items.get(id) : undefined
  const next = target && target.status.input === 'enter' && target.status.state !== 'error' ? id : null
  if (next === entered) return next !== null
  const before = entered ? items.get(entered) : undefined
  entered = next
  before?.world?.setEntered(false)
  target?.world?.setEntered(next !== null)
  for (const listener of enteredListeners) listener()
  return next !== null
}

// ---------- Items ----------

// The items outlive a hot reload of this file or of the world files in dev.
const items: Map<string, LiveItem> = (import.meta.hot?.data.items as Map<string, LiveItem> | undefined) ?? new Map()
if (import.meta.hot) import.meta.hot.data.items = items

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** The timeline of a world in the playing scene whose clock it follows (the first scene that plays it, as in player.ts). */
function playingTimeline(id: string): LiveTimeline | null {
  for (const play of scenePlayer.playingScenes()) {
    const timeline = sceneTimelineOf(play, id)
    if (timeline) return timeline
  }
  return null
}

/** The clock of a world that no scene plays: from where its scene ended (LiveNode.rest), else 0, in real time. */
function restClock(node: LiveNode): { clock: ItemClock; scene: SceneView } {
  const rest = node.rest
  const t = rest && Number.isFinite(rest.t) && rest.t >= 0 ? rest.t : 0
  const step = rest && typeof rest.step === 'string' ? rest.step : null
  return { clock: { t, at: absNow(), rate: 1 }, scene: { t, playing: false, active: false, ended: true, step } }
}

/** One world on the page, driven by its view (LiveView). */
export class LiveItem {
  node: LiveNode
  /** The last report() values. */
  report: unknown = undefined
  status: LiveStatus = { state: 'paused', frames: 0 }
  private seed: number
  private visible = false
  private host: WorldHost | null = null
  /** The generation while it steps to its clock (hidden; it gets no clock and no params until it goes live), and when it is done. */
  private stepping: { host: WorldHost; done: Promise<void> } | null = null
  /** A generation that was replaced: it shows its last picture until the next one draws. */
  private leaving: { host: WorldHost; timer: number } | null = null
  private clock: ItemClock
  private scene: SceneView
  private sceneEnd = 0
  private params: Record<string, number>
  private frames = 0
  private frameBase = 0
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
    if (!worldsTrusted()) {
      this.status = { state: 'untrusted', frames: 0 }
      onStatus(this.status)
    }
    items.set(id, this)
    const clock = playbackClocks.get(id)
    if (clock) this.sceneClockChanged(clock)
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
    if (!worldsTrusted()) return 'untrusted'
    return this.visible ? 'running' : 'paused'
  }

  // ----- Generations -----

  private wantsHost(): boolean {
    return worldsTrusted() && (this.visible || this.scene.active)
  }

  private runs(): boolean {
    return this.wantsHost() && document.visibilityState !== 'hidden'
  }

  private ensureHost(): void {
    if (!this.host && this.wantsHost() && this.status.state !== 'error') this.startHost()
  }

  /** The generation steps to its clock now: the timeline of its scene, or null (it starts live at the clock's tick). */
  private stepTimeline(): LiveTimeline | null {
    if (!this.scene.active || tickOf(itemTime(this.clock)) === 0) return null
    return playingTimeline(this.id)
  }

  private get catchingUp(): boolean {
    return this.host !== null && this.stepping?.host === this.host
  }

  private startHost(): void {
    const timeline = this.stepTimeline()
    this.frameBase += this.frames
    this.frames = 0
    this.report = undefined
    if (this.status.state !== 'error') this.setStatus('starting')
    let host: WorldHost | null = null
    const current = (): boolean => host !== null && this.host === host
    const events: HostEvents = {
      onAlive: (frames) => {
        if (!current()) return
        this.frames = frames
        // The new generation drew: the one it replaces goes (a stepping one shows when it reaches its clock).
        if (frames > 0 && !this.catchingUp) this.endLeaving()
        if (this.status.state === 'starting') this.setStatus(this.shownState())
        else this.status = { ...this.status, frames: this.frameBase + frames }
      },
      onError: (message) => {
        if (!current()) return
        this.endLeaving()
        this.setStatus('error', message)
      },
      onLost: (planned) => {
        if (!current()) return
        if (planned) this.restart()
        else this.lost()
      },
      onInput: (mode) => {
        if (current()) this.setStatus(this.status.state, this.status.error, mode)
      },
      onReport: (values) => {
        if (current()) this.report = values
      }
    }
    host = new WorldHost(
      {
        id: this.id,
        code: this.node.code,
        data: this.node.data,
        pins: this.node.pins,
        seed: this.seed,
        w: this.node.w,
        h: this.node.h,
        // Stepping: the world's own params under the timeline's, as in a preview.
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
  }

  /**
   * A stepping generation runs every tick from the scene's start to the
   * clock's tick (again while the clock moves on), then shows and goes live.
   * The picture of the generation before it shows meanwhile.
   */
  private async stepToClock(host: WorldHost): Promise<void> {
    let to = tickOf(itemTime(this.clock))
    for (;;) {
      const at = await host.advance(to, false)
      if (!at || this.host !== host) return
      to = tickOf(itemTime(this.clock))
      if (to - at.tick <= BEHIND_TICKS) break
    }
    this.stepping = null
    host.goLive(this.clock, this.scene, this.params)
    this.endLeaving()
  }

  /** A replaced generation shows its last picture until the next one draws (at most `ms`; 0: no limit). A stepping one shows nothing, so the picture before it stays. */
  private retire(host: WorldHost, ms: number): void {
    if (this.stepping?.host === host) {
      this.stepping = null
      host.dispose()
      return
    }
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

  /** A new generation at the clock now (a jump of the clock, a lost worker). */
  private restart(): void {
    const old = this.host
    this.host = null
    if (old) this.retire(old, this.stepTimeline() ? 0 : SWAP_MS)
    if (this.wantsHost()) this.startHost()
  }

  private lost(): void {
    const now = performance.now()
    this.losses = [...this.losses.filter((at) => now - at < LOSS_WINDOW_MS), now]
    if (this.losses.length < MAX_LOSSES) {
      this.restart()
      return
    }
    this.setStatus('error', `The world's worker was lost ${MAX_LOSSES} times in a minute.`)
    const old = this.host
    this.host = null
    if (old) this.retire(old, 0)
  }

  // ----- Clock and params -----

  /** The scene clock of this world now (each playback frame), or null when no scene plays it. */
  sceneClockChanged(clock: SceneClock | null): void {
    const now = absNow()
    const predicted = itemTime(this.clock, now)
    if (clock) {
      const rate = clock.playing ? 1 : 0
      this.sceneEnd = clock.end
      // The same clock as the world has (it moves on by itself): nothing to send.
      if (this.scene.active && rate === this.clock.rate && clock.step === this.scene.step && Math.abs(clock.t - predicted) < 1 / TICK_HZ) return
      // A seek or a replay: back in time, or forward by more than the clock moves by itself.
      const jump = clock.t < predicted - 2 / TICK_HZ || clock.t > predicted + JUMP_S
      this.clock = { t: clock.t, at: now, rate }
      const starts = !this.scene.active
      this.scene = { t: clock.t, playing: clock.playing, active: true, ended: false, step: clock.step }
      // A failed world stays stopped: a hung world would hang every world again.
      if (jump && this.host && this.status.state !== 'error') this.restart()
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

  private wantChanged(): void {
    this.ensureHost()
    this.host?.run(this.runs())
  }

  private followClock(): void {
    // A stepping generation reads the clock when it goes live.
    if (!this.catchingUp) this.host?.follow(this.clock, this.scene)
  }

  paramsChanged(): void {
    const next = this.currentParams()
    if (sameParams(next, this.params)) return
    this.params = next
    if (!this.catchingUp) this.host?.setParams(next)
  }

  /** The view got a new node object. */
  update(node: LiveNode): void {
    const before = this.node
    this.node = node
    const seed = seedOf(node)
    if (node.code !== before.code || seed !== this.seed || JSON.stringify(node.data) !== JSON.stringify(before.data)) {
      this.seed = seed
      this.params = this.currentParams()
      this.endLeaving()
      this.host?.dispose()
      this.host = null
      this.stepping = null
      this.setStatus(worldsTrusted() ? 'paused' : 'untrusted', undefined, undefined)
      this.ensureHost()
      return
    }
    if (node.pins !== before.pins) this.world?.setPins(node.pins ?? [])
    if (node.w !== before.w || node.h !== before.h) this.host?.resize(node.w, node.h)
    if (node.params !== before.params) this.paramsChanged()
  }

  // ----- Visibility -----

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.wantChanged()
    if (this.status.state === 'running' || this.status.state === 'paused') this.setStatus(this.shownState())
  }

  /** The learner trusted the folder (the wanted world starts now) or stopped trusting it (its generations end). */
  trustChanged(trusted: boolean): void {
    if (!trusted) {
      if (entered === this.id) enterLive(null)
      this.endLeaving()
      this.host?.dispose()
      this.host = null
      this.stepping = null
      if (this.status.state !== 'error') this.setStatus('untrusted', undefined, undefined)
      return
    }
    if (this.status.state === 'untrusted') this.setStatus(this.visible ? 'running' : 'paused', undefined, undefined)
    this.wantChanged()
  }

  /** The window was hidden or shown: worlds run only while it shows. */
  windowShown(shown: boolean): void {
    this.host?.run(shown && this.wantsHost())
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** The host, while this world runs. */
  get world(): WorldHost | null {
    return this.status.state !== 'error' ? this.host : null
  }

  /** The current pixels and their tick (agent screenshots); a step host makes them when the world has no host. Null when there is no picture. */
  async still(): Promise<LiveFrame | null> {
    if (this.status.state === 'error' || !worldsTrusted()) return null
    if (this.catchingUp && this.stepping) {
      // A stepping generation shows its picture when it reaches its clock.
      await Promise.race([this.stepping.done, new Promise((resolve) => window.setTimeout(resolve, STEP_WAIT_MS))])
      if (this.catchingUp) return null
    }
    if (this.host) {
      const frame = await this.host.capture()
      if (frame?.url) return frame
    }
    return stillAt(this.node, this.params, itemTime(this.clock), window.devicePixelRatio || 1)
  }

  dispose(): void {
    if (entered === this.id) enterLive(null)
    this.endLeaving()
    this.host?.dispose()
    this.host = null
    this.stepping = null
    if (items.get(this.id) === this) items.delete(this.id)
  }
}

/**
 * In the board's paint: each world is wanted while its rect is within one
 * screen of the view, so what it reaches is there when it comes into view.
 */
export function nearWorlds(view: { x: number; y: number; width: number; height: number }, rectOf: (id: string) => { x: number; y: number; w: number; h: number } | null): void {
  for (const item of items.values()) {
    const rect = rectOf(item.id)
    if (!rect) continue
    item.setVisible(rect.x < view.x + view.width * 2 && rect.x + rect.w > view.x - view.width && rect.y < view.y + view.height * 2 && rect.y + rect.h > view.y - view.height)
  }
}

const offTrust = onWorldsTrust((trusted) => {
  for (const item of items.values()) item.trustChanged(trusted)
  // No world code stays: the board surfaces' workers end too (a step host's watch ends it, stills.ts).
  if (!trusted) endWorldWorkers()
})
import.meta.hot?.dispose(() => offTrust())

document.addEventListener('visibilitychange', () => {
  const shown = document.visibilityState !== 'hidden'
  for (const item of items.values()) item.windowShown(shown)
})

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

/** The worlds that a wheel can reach: input "direct", with a wheel listener. */
export function wheelWorlds(): string[] {
  return worldItems()
    .filter((item) => item.status.input === 'direct' && item.world?.wants.wheel)
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

// ---------- For agents, the snapshot path and dev checks ----------

/** The status of a world on this page, or null when it is not shown. */
export function liveStatus(id: string): LiveStatus | null {
  return items.get(id)?.status ?? null
}

/** The current pixels of a world and their tick, or null. */
export function liveStill(id: string): Promise<LiveFrame | null> {
  return items.get(id)?.still() ?? Promise.resolve(null)
}

/** One line for list_items: "world, params k=1 omega=2, code 532 chars, running". */
export function liveSummary(node: LiveNode): string {
  if (isOldLive(node)) return `${node.mode}, an older kind of item that no longer runs`
  const params = Object.entries(node.params)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ')
  const status = liveStatus(node.id)
  const state = status ? (status.state === 'error' ? 'error (get_item shows it)' : status.state === 'untrusted' ? `paused. ${UNTRUSTED_NOTE}` : status.state) : 'not shown'
  return `world${params ? `, params ${params}` : ''}, code ${node.code.length} chars, ${state}`
}

/** Every world on the page with its status (dev checks). */
export function liveItems(): Array<{ id: string; visible: boolean; host: boolean } & LiveStatus> {
  return [...items.values()].map((item) => ({ id: item.id, visible: item.isVisible, host: item.world !== null, ...item.status }))
}

/** Totals for dev checks. */
export function liveResources(): { items: number; hosts: number } {
  const list = liveItems()
  return { items: list.length, hosts: list.filter((item) => item.host).length }
}

/** The last report() values of a world on this page (get_item), or undefined. */
export function liveReport(id: string): unknown {
  return items.get(id)?.report
}

/** Check a world's code: its first error; null when it is fine. */
export function validateWorld(code: string, params: Record<string, number> = {}, size?: [number, number], data?: unknown): Promise<string | null> {
  return worldError(code, params, size, data)
}
