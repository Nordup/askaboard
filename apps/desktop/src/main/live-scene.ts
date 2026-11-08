import { MessageChannelMain, type WebContents } from 'electron'
import { BOARD_LAYOUT } from '@shared/board-format'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription } from '@shared/live-scene'
import { IPC } from '@shared/space-api'
import { siteLabel, type SceneSource, type StageProgram } from '@shared/scene-program'
import { programTooLarge, STAGE_LIMITS, type FromStage, type StageMode, type StageReply, type StageTiming, type ToStage } from '@shared/stage-protocol'
import { NO_CODE_ITEMS, NO_HTML } from './lab-switch'
import { stageProgram } from './scene-files'
import { StageProcess } from './stage-process'
import { voiceAnswers } from './voice'

/**
 * The stage: one long-lived sandbox per board in which every scene program
 * (write_scene, play_scene) runs, so objects, values, helpers and `stage` made by one
 * program are there for the next. The sandbox is a V8 realm in a worker of
 * the stage process, a hidden, sandboxed Chromium renderer (stage-process.ts,
 * stage/worker.ts); the app has one stage process.
 *
 * The stage keeps a log of the programs it ran (source snapshot, context, seed). Its
 * state is always the result of running that log in order, which makes it
 * possible to roll it back: after a program error, a draft run, a cancel, a
 * skipped scene, a replaced or cut scene, and after the stage process
 * crashed, the context is rebuilt in a new worker by running the log again
 * (fast: programs only compute, and a rebuild does not sample).
 * The stage starts new when the board changes, on play_scene reset, and
 * when the app starts.
 *
 * Frames: the samples of a program's changing objects go from the stage
 * page straight to the board renderer over a MessagePort (shared/frames.ts).
 * This class makes the channel and hands one end to each (linkFrames): when
 * the stage process starts, and when the board window loads (linkBoard). A
 * program's run id is the id of its frames (StageRun.job); the reply comes
 * when the board has every chunk sent before it.
 *
 * A run whose frames go to the board (a draft, a scene, a sampled re-run)
 * replies before its sweep ends, so the board plays while the frames arrive;
 * only a world whose values change sweeps first (stage/worker.ts finish). One
 * record (Producer) lives from that reply to the sweep's terminal event: done,
 * failed, cancelled, a window reload or a crash. A scene bakes at the sweep's
 * end, so after "swept" the context holds it; a draft does not. Work of another
 * operation that needs the realm finds it busy until that event (needRealm,
 * RealmBusy): it leaves the stage lock, waits (sweepDone) and starts again
 * (main/mcp.ts onRealm). The operation that started the sweep waits for it
 * inside the lock before its next run (ownSweep). A play, a preview and play controls do not need the
 * realm. The answer recorder and the place of the run stay alive with the record.
 */

/** An error of a scene program, at a line of the inline code ("Line 12: …") or of a scene file (file: "lib/arrows.js line 12: …"). detail: the message without the place. */
export class SceneProgramError extends Error {
  constructor(
    readonly detail: string,
    readonly line: number | null,
    readonly file: string | null = null
  ) {
    super(line ? `${siteLabel({ file, line })}: ${detail}` : file ? `${file}: ${detail}` : detail)
  }
}

/** A sweep holds the realm. Nothing waits for it inside the stage lock: main/mcp.ts onRealm leaves the lock, waits and starts the operation again. */
export class RealmBusy extends Error {
  constructor() {
    super('A sweep holds the stage.')
  }
}

/** Names that agents guess for scene functions, and what to write instead. */
const MISNAMED: Record<string, string> = {
  show: 'To draw or show an object, write draw(obj); to fade it in, write fadeIn(obj).',
  reveal: 'To draw or show an object, write draw(obj); to fade it in, write fadeIn(obj).',
  appear: 'To draw or show an object, write draw(obj); to fade it in, write fadeIn(obj).',
  hide: 'To fade an object out, write fadeOut(obj); to wipe it away, write erase(obj).',
  sleep: 'To wait, write await wait(seconds).',
  delay: 'To wait, write await wait(seconds).',
  animate: 'To animate an object, write tween(obj, {x, y, scale, rotate, opacity, color, …}, seconds).'
}

/** The program was cancelled (play_scene stop/clear_queue/cancel, or the client went away) before it finished. */
export class SceneCancelled extends Error {
  constructor() {
    super('Cancelled: the scene program was stopped before it finished (play_scene stop, clear_queue or cancel, or the client cancelled the call). Nothing was drawn, and no draft changed.')
  }
}

/** One program the stage ran, in order. scene: the renderer's scene id once it is committed. source: the snapshot it runs (every run of it runs the same one). */
export interface StageEntry {
  scene: string | null
  source: SceneSource
  name: string | null
  seed: number
  /** The time the scene was cut at (play_scene cut), or null. It is also in ctxText; a run of this entry again (restage, rollback) passes it on. */
  cutAt: number | null
  ctxText: string
  /** The board's answers to the program's host requests (text measures, html, image, space, copy), by request: a replay gets the same ones. */
  answers: Map<string, string>
  /** The stage id and scene-local key of each object the program made, from its last run (stage/live-prelude.js keyFor). */
  keys?: Array<[number, string]>
  /**
   * The stage ids the program took, [first, end) (stage/live-prelude.js range). A run of it again starts at first, and the ids of
   * a program before it that does not run (marked, dropped) stay empty, so stage ids never shift: a saved context's ids name
   * the same objects in every rebuild. Records from before 2026-10-30 have none (their programs run where the log has room).
   */
  range?: [number, number]
  /**
   * The one failure state of a program (decision of 2026-10-29): why it cannot run again, or undefined. Its code is missing,
   * it threw or stopped the stage when the stage was rebuilt, a cancel stopped it while the stage was rebuilt, its record is
   * of an older key scheme, or its re-run does not match its record. A marked program keeps its place in the log, so its
   * scene and its items stay on the board and it can be replaced, but no rebuild runs it, a restage leaves it as it is, and
   * a replay of it says that it could not be rebuilt.
   */
  failed?: string
  /** Its sweep failed after the reply: the error with its place and scene time. Rebuilds do not sample, so it can still run; a draft with this cannot start. */
  sweepError?: string
}

export interface StageRun {
  /** The description without the samples (the frames of its dynamic objects are in the board renderer). */
  desc: SceneDescription
  entry: StageEntry
  /** Set when this program was the first one of a new stage: why the stage is new. */
  fresh: string | null
  /** The frames of this run in the board renderer: their job id and their number of chunks (renderer/live/frames.ts). */
  job: number
  frames: number
  /** Where the run's time went, in ms (the session trace's spans): stage_ready_ms (a new process or a rebuild first), stage_run_ms, and the stage's own parts. */
  timing: Record<string, number>
  /** The objects whose recipe gave the sweep another result than its seed at the same moment. */
  orderDependent: string[]
}

/** A tex() or text() node to measure: its source, math or not, and its font size. */
export interface TextItem {
  math: boolean
  text: string
  size: number
}

/** A request from the sandbox that the board answers (html(), image(), space(), copy()): plain JSON in and out. */
export type HostRequest = { kind: 'html' | 'space' | 'item' | 'glyphs' } & Record<string, unknown>

/** A sweep after its early reply: the board and the version of the scene it streams, its job, and the operation (exclusive) that ran it. entry is null only until run() has it. done: true when the sweep ended complete. */
interface Producer {
  job: number
  board: string | null
  entry: StageEntry | null
  operation: number
  done: Promise<boolean>
  end: (complete: boolean) => void
}

/** A sweep's terminal event. notes: what the agent should read about it, one line each. failed: its stream ended with an error, not with a cut. */
export interface SweepEnd {
  job: number
  board: string | null
  complete: boolean
  failed: boolean
  notes: string[]
}

/** The seed of a program's first run (Math.random in the sandbox). */
export const newSeed = (): number => Math.floor(Math.random() * 2 ** 31) + 1

/** The error of a reply that never came, because the program was cancelled. */
const CANCELLED = 'cancelled'

/** The text layout a recorded text measure was taken under (BOARD_LAYOUT); 1 for a record from before the layout was recorded. */
function measureLayout(answer: string): number {
  try {
    const layout = (JSON.parse(answer) as { layout?: unknown }).layout
    return typeof layout === 'number' ? layout : 1
  } catch {
    return 1
  }
}
/** The error of a program that ended the stage process by going over V8's heap limit (stage-process.ts, onGone). */
const TOO_MUCH_MEMORY = 'The scene program ran out of memory and was stopped. The stage is rebuilt from the programs before it.'
export class SceneStage {
  /** Measured text sizes (board points) by math, size and source; null: could not be measured. */
  private textCache = new Map<string, [number, number] | null>()
  /** The answers of the program that runs now: recorded (and, for a replay, given back) by request; place: where it runs (StagePlace.board). */
  private answers: { record: Map<string, string>; given: Map<string, string> | null; place?: unknown } = { record: new Map(), given: null }

  /**
   * measureText: the renderer lays the text out as the board does (renderer/live/measure.ts).
   * host: the renderer answers html(), image(), space() and copy() requests (renderer/live/host.ts).
   * sweepEnded: a sweep's terminal event.
   */
  constructor(
    private readonly measureText: (items: TextItem[]) => Promise<Array<[number, number]>>,
    private readonly host: (request: HostRequest, place: unknown) => Promise<unknown>,
    private readonly sweepEnded: (end: SweepEnd) => void
  ) {
    this.process = new StageProcess(
      (message, reply) => this.onStageMessage(message, reply),
      (why, outOfMemory) => this.onStageGone(why, outOfMemory)
    )
  }

  /** Start the stage process and load the scene library now, not in the first scene (a log restored by then is rebuilt by its own operation). */
  warm(): void {
    void this.exclusive(async () => (this.log.length ? undefined : this.ensure())).catch(() => undefined)
  }

  private async textSizes(items: TextItem[]): Promise<Array<[number, number] | null>> {
    const key = (item: TextItem): string => `${item.math ? 'm' : 't'}|${item.size}|${item.text}`
    const missing = items.filter((item) => !this.textCache.has(key(item)))
    if (missing.length) {
      try {
        const sizes = await this.measureText(missing)
        missing.forEach((item, i) => this.textCache.set(key(item), sizes[i] && sizes[i][0] > 0 ? sizes[i] : null))
      } catch {
        for (const item of missing) this.textCache.set(key(item), null)
      }
    }
    return items.map((item) => this.textCache.get(key(item)) ?? null)
  }

  private readonly process: StageProcess
  private nextId = 1
  private pending = new Map<number, (reply: StageReply) => void>()
  /** The entry of each run in flight: its sweep has it from the early reply on, so a sweep that fails at once keeps its error on it. */
  private inFlight = new Map<number, StageEntry>()
  /** The board window's renderer: the other end of the frames port. */
  private boardContents: WebContents | null = null
  private linkWaiters: Array<() => void> = []
  private chain: Promise<unknown> = Promise.resolve()
  private epochNo = 0
  private boardPath: string | null = null
  /** The stage's context does not match the log (an error, a draft run, a cancel, a new process): rebuild before the next run. */
  private dirty = true
  /** How many programs of the log the context holds when it is not dirty (fewer than the log after a draft ran at a place). */
  private held = 0
  /**
   * A sweep streams, or the last one ended without its bake (it failed or was cut): the context lacks the end of that
   * scene. Only a complete sweep and a new context clear it, so a later write of dirty cannot hide it (clean).
   */
  private unbaked = false
  /** The context holds the log up to held: nothing failed, and the last sweep ended and baked. */
  private get clean(): boolean {
    return !this.dirty && !this.unbaked
  }
  /** The program that the last run ran before (a draft at a place), or null: the end of the log. The next run usually runs there too (settle). */
  private lastPlace: StageEntry | null = null
  /** Why the stage is new, until its first program runs. */
  private freshReason: string | null = 'the app started'
  readonly log: StageEntry[] = []
  /** Changes with every change of the log (a program added or taken out, a reset): a draft run on an older revision must run again. */
  revision = 0

  get epoch(): string {
    return `st${this.epochNo}`
  }

  /** The operation that has the stage now (exclusive): a sweep it started is its own (ownSweep). */
  private operation = 0

  /** Run fn with the stage to itself (programs, commits and restaging never interleave). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      this.operation++
      return fn()
    }
    const run = this.chain.then(start, start)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** A new, empty stage. Board items stay; objects and values from earlier programs are gone. */
  reset(reason: string): void {
    this.epochNo++
    this.revision++
    this.log.length = 0
    this.dirty = true
    this.freshReason = reason
  }

  /** The stage after the board changed, with the renderer's record of it (its items, by stage object). */
  adopt(context: SceneContext): void {
    if (context.board !== undefined && context.board !== this.boardPath) {
      if (this.boardPath !== null) this.reset('the board changed')
      this.boardPath = context.board
    }
    if (!context.stage || context.stage.epoch !== this.epoch) context.stage = { epoch: this.epoch, items: {} }
  }

  /**
   * The board-change operation (App.tsx changeBoard): a renamed board keeps its stage under
   * the new path; a board that went to the Trash ends its stage. Other boards change nothing.
   */
  boardMoved(from: string, to: string | null): void {
    if (this.boardPath !== from) return
    if (to) {
      this.boardPath = to
      return
    }
    this.reset('the board went to the Trash')
    this.boardPath = null
  }

  /** Scenes that will never play (skipped): their programs leave the stage. */
  drop(sceneIds: string[]): void {
    const before = this.log.length
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i]
      if (!entry.scene || !sceneIds.includes(entry.scene)) continue
      // A scene that leaves the board: its stream has no more use.
      this.cancelSweep(entry)
      this.log.splice(i, 1)
    }
    if (this.log.length !== before) {
      this.dirty = true
      this.revision++
    }
  }

  /** Forget a program whose scene was not committed: its stream, when it still sweeps, has no more use. */
  discard(entry: StageEntry): void {
    this.cancelSweep(entry)
    const index = this.log.indexOf(entry)
    if (index >= 0) {
      this.log.splice(index, 1)
      this.revision++
    }
    this.dirty = true
  }

  /**
   * Add a program that ran as a draft (mode "draft") to the log, as if it had
   * run in mode "scene": the caller checked that the log and the board did not
   * change since. The stage is rebuilt from the log before the next run.
   */
  adoptDraft(entry: StageEntry): void {
    this.log.push(entry)
    this.revision++
    this.freshReason = null
    this.dirty = true
  }

  /**
   * The log of a stage that starts new, from the board's scene records (main/mcp.ts restoreStage): the
   * programs of the current segment, in order. The context is built from them at the next ensure.
   */
  restore(entries: StageEntry[]): void {
    this.log.length = 0
    this.log.push(...entries)
    this.revision++
    this.dirty = true
    this.freshReason = null
  }

  /** Put a marked program (failed) back at the end of the log as it is, without running it (a restage keeps its place). */
  keep(entry: StageEntry): void {
    this.log.push(entry)
    this.revision++
    this.dirty = true
  }

  /** Mark a program that cannot run again (StageEntry.failed). Its objects leave the stage, and the stage is rebuilt without it. */
  mark(entry: StageEntry, why: string): void {
    if (entry.failed) return
    console.warn(`stage: the program of scene ${entry.name ?? entry.scene ?? '?'} is marked and no longer runs: ${why}`)
    entry.failed = why
    entry.keys = undefined
    this.revision++
    this.dirty = true
  }

  /** Each object of the log's programs that runs, by owner (stage id, scene id, key: what a restore gives the renderer), and why each marked program cannot run. */
  identities(): { keys: Array<[number, string, string]>; failed: Array<[string, string]> } {
    const keys: Array<[number, string, string]> = []
    const failed: Array<[string, string]> = []
    for (const entry of this.log) {
      if (!entry.scene) continue
      if (entry.failed) failed.push([entry.scene, entry.failed])
      else for (const [sid, key] of entry.keys ?? []) keys.push([sid, entry.scene, key])
    }
    return { keys, failed }
  }

  /** The context holds the whole log now (a restore: the keys of every program are known after it). signal cancels it. */
  async rebuild(signal?: AbortSignal): Promise<void> {
    await this.withSignal(signal, () => this.ensure(null, signal))
  }

  /** The context is what the next run needs (settle): the log up to the place of the last run. */
  get settled(): boolean {
    return this.clean && this.held === this.placeIndex(this.lastPlace)
  }

  /**
   * Rebuild while the stage is idle (main/mcp.ts rebuildWhenIdle), so that the next run waits for nothing: up to the
   * place of the last run, because a new version of a scene usually follows at the same place. signal stops it at once,
   * in a program too: that program is not at fault, so it is not marked, and the context stays dirty. A stopped stage
   * process stays stopped: the next real operation starts it. Runs inside exclusive.
   */
  async settle(signal: AbortSignal): Promise<void> {
    await this.withSignal(signal, () => this.ensure(this.lastPlace, signal, false), false)
  }

  /**
   * Run the log again from a new context and sample the programs of `wanted` as scenes (their frames go
   * to the board), in order, so each runs on the stage as it was when it first ran: a replay after a
   * restart (main/mcp.ts ensureMemories). onRun gets each sampled run at its early reply, while its
   * frames still stream; the next program waits for that sweep (ownSweep). A program that fails, that
   * onRun marks (its re-run does not match its record), or whose sweep does not end complete, changes
   * the context: the run starts again without it. The other programs run as a rebuild. The run ends
   * after the last wanted program, so its replay starts while its frames arrive: the context then holds
   * the log up to there, and the idle rebuild (settle) runs the rest once the sweep is done. signal
   * cancels it. Runs inside exclusive.
   */
  async resample(wanted: ReadonlySet<StageEntry>, onRun: (entry: StageEntry, run: { desc: SceneDescription; job: number; frames: number }) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.withSignal(signal, async () => {
      this.needRealm()
      const started = Date.now()
      const done = new Set<StageEntry>()
      const left = (): boolean => [...wanted].some((entry) => !entry.failed && !done.has(entry))
      let sampled = 0
      let upTo = 0
      for (let again = true; again; ) {
        again = false
        // A sweep of this run whose scene is marked now: its stream has no more use.
        this.cancelSweep()
        await this.startProcess()
        await this.resetContext(signal)
        for (upTo = 0; upTo < this.log.length && left(); upTo++) {
          const entry = this.log[upTo]
          if (entry.failed) continue
          if (!(await this.ownSweep(signal))) {
            again = true
            break
          }
          const sample = wanted.has(entry) && !done.has(entry)
          const ran = await this.runAgain(entry, sample ? 'scene' : 'replay', signal)
          // A program that failed may have changed the context before it failed: start again without it.
          if (!ran) {
            again = true
            break
          }
          if (!sample) continue
          done.add(entry)
          let desc: SceneDescription
          try {
            desc = JSON.parse(ran.json as string) as SceneDescription
          } catch (error) {
            this.mark(entry, `The scene could not be read: ${error instanceof Error ? error.message : String(error)}`)
            again = true
            break
          }
          desc.stage = this.epoch
          sampled++
          const tRun = Date.now()
          await onRun(entry, { desc, job: ran.job, frames: ran.frames })
          const t = ran.timing
          if (t) console.log(`stage: sampled ${entry.name ?? entry.scene} for a replay: ${ran.streams ? 'its frames stream' : 'swept before the reply (a world steps)'}; seeds ${Math.round(t.seeds)} ms, sampling ${Math.round(t.result)} ms, ${(t.bytes / 1024 / 1024).toFixed(2)} MB before the reply; the board took it in ${Date.now() - tRun} ms`)
          if (signal?.aborted) throw new SceneCancelled()
          if (entry.failed) {
            again = true
            break
          }
        }
      }
      // The context holds the log up to there once the last sweep is done and baked (unbaked until then).
      this.dirty = false
      this.held = upTo
      console.log(`stage: ran ${upTo} of ${this.log.length} programs again and sampled ${sampled} in ${Date.now() - started} ms`)
    })
  }

  /** A new, empty context in the stage process (a cancel ends this operation first: it never goes on to run the log). */
  private async resetContext(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SceneCancelled()
    const reset = await this.send({ t: 'reset', id: this.nextId++ })
    if (signal?.aborted) throw new SceneCancelled()
    if (!reset.ok) throw new SceneProgramError(reset.error, null)
    this.dirty = true
    this.unbaked = false
  }

  /**
   * A program of the log runs again on its saved context (savedContext), as a rebuild ("replay") or sampled ("scene"), at its
   * own stage ids (StageEntry.range). A failure, or a run that takes other stage ids, marks it and returns null. A program
   * whose record has no range runs at the end of the ranges before it; when a marked program before it has none either,
   * that place is not known, and it is marked. A cancel throws SceneCancelled and never marks a program that was not
   * running (a program a cancel stops while it runs is marked: see cancel).
   */
  private async runAgain(entry: StageEntry, mode: 'replay' | 'scene', signal?: AbortSignal): Promise<{ json: string | null; job: number; frames: number; timing: StageTiming | null; streams: boolean } | null> {
    if (signal?.aborted) throw new SceneCancelled()
    const index = this.log.indexOf(entry)
    if (!entry.range && this.log.slice(0, index).some((before) => before.failed && !before.range)) {
      this.mark(entry, 'a scene before it could not run, and its record does not say which stage ids it had')
      return null
    }
    let ctxText: string
    try {
      const ctx = this.savedContext(entry)
      ctxText = JSON.stringify({ ...ctx, stage: { ...ctx.stage, first: entry.range?.[0] ?? this.firstId(index) }, ...(voiceAnswers(entry.answers).size ? { voice: true } : {}) })
    } catch (error) {
      this.mark(entry, `its saved context cannot be read (${error instanceof Error ? error.message : String(error)})`)
      return null
    }
    const job = this.nextId++
    this.answers = { record: new Map(), given: entry.answers }
    this.rebuilding = entry
    let reply: StageReply
    try {
      reply = await this.send({ t: 'run', id: job, program: stageProgram(entry.source), ctxText, mode }, entry)
    } finally {
      // A sweep still asks the board, and gets the recorded answers: its end closes them (endProducer).
      if (!this.producer || this.producer.job !== job) this.answers = { record: new Map(), given: null }
      this.rebuilding = null
    }
    if ((!reply.ok && reply.error === CANCELLED) || signal?.aborted) throw new SceneCancelled()
    if (!reply.ok) {
      // A program that ran before and fails now (its code is gone, it read something that changed, or it stopped the stage process).
      this.mark(entry, reply.error)
      return null
    }
    if (entry.range && (reply.range?.[0] !== entry.range[0] || reply.range[1] !== entry.range[1])) {
      this.cancelSweep(entry)
      this.mark(entry, `its re-run took the stage ids ${reply.range?.join('–')}, not ${entry.range.join('–')}`)
      return null
    }
    entry.keys = reply.keys ?? []
    entry.range = reply.range ?? undefined
    return { json: reply.json, job, frames: reply.frames, timing: reply.timing, streams: reply.sweeping }
  }

  /** The first stage id after the ranges of the log's first `upTo` programs (also of marked ones: their ids stay empty). */
  private firstId(upTo: number): number {
    let first = 0
    for (const entry of this.log.slice(0, upTo)) if (entry.range) first = Math.max(first, entry.range[1])
    return first
  }

  /** The saved context of a program of the log, bound to this stage: its epoch and the board's path now (a renamed board). Its stage ids still name the same objects (StageEntry.range). */
  savedContext(entry: StageEntry): SceneContext {
    const ctx = JSON.parse(entry.ctxText) as SceneContext
    return { ...ctx, ...(this.boardPath !== null ? { board: this.boardPath } : {}), stage: { epoch: this.epoch, items: ctx.stage?.items ?? {} } }
  }

  /** The program of the log that runs again now (a rebuild): a cancel stops it, and it is marked, so no rebuild waits on it again. */
  private rebuilding: StageEntry | null = null

  /** fn with signal: its abort cancels what runs on the stage (byUser: see cancel). */
  private async withSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, byUser = true): Promise<T> {
    if (signal?.aborted) throw new SceneCancelled()
    const onAbort = (): void => this.cancel(undefined, byUser)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await fn()
    } catch (error) {
      throw signal?.aborted ? new SceneCancelled() : error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Keep only the programs before this scene (to run it, and the ones after, again). Returns its place in the log, its program and the programs after it, or null when the scene is not in the log. */
  truncateBefore(sceneId: string): { index: number; entry: StageEntry; later: StageEntry[] } | null {
    const index = this.log.findIndex((entry) => entry.scene === sceneId)
    if (index < 0) return null
    const entry = this.log[index]
    const later = this.log.slice(index + 1)
    this.truncate(index)
    return { index, entry, later }
  }

  /** Keep only the first `length` programs of the log. */
  truncate(length: number): void {
    if (this.log.length > length) this.log.length = length
    this.revision++
    // A context that holds exactly these programs stays good (settle at the place of a new version).
    if (this.held !== length) this.dirty = true
  }

  /** The sweep that runs after a draft's reply, or null. */
  private producer: Producer | null = null

  get sweeping(): boolean {
    return this.producer !== null
  }

  /** The one gate of the realm: every operation that needs it passes here, inside the stage lock, before it changes anything. Its own sweep does not stop it (ownSweep). */
  needRealm(): void {
    if (this.producer && this.producer.operation !== this.operation) throw new RealmBusy()
  }

  /** Wait for the sweep's terminal event: true when it ended complete (also when there is none). A signal ends the wait, not the sweep. */
  async sweepDone(signal?: AbortSignal | null): Promise<boolean> {
    const producer = this.producer
    if (!producer) return true
    return new Promise<boolean>((resolve, reject) => {
      if (signal?.aborted) reject(new SceneCancelled())
      signal?.addEventListener('abort', () => reject(new SceneCancelled()), { once: true })
      void producer.done.then(resolve)
    })
  }

  /**
   * The gate of each run on the realm: another operation's sweep throws RealmBusy (needRealm); this operation's own
   * sweep is waited for here, inside the lock, as a run that swept before its reply would have held it. False: the
   * sweep did not end complete, so the context is not what the log says (it is dirty).
   */
  private async ownSweep(signal?: AbortSignal): Promise<boolean> {
    this.needRealm()
    return this.sweepDone(signal)
  }

  /** The record's end: what waited on the sweep goes on, and the answers of its run are closed. */
  private endProducer(complete: boolean, failed = false, notes: string[] = []): void {
    const producer = this.producer
    if (!producer) return
    this.producer = null
    this.answers = { record: new Map(), given: null }
    producer.end(complete)
    this.sweepEnded({ job: producer.job, board: producer.board, complete, failed, notes })
  }

  /** End the sweep now (of this version only, when one is named): its stream stops where it is. */
  cancelSweep(entry?: StageEntry): void {
    if (!this.producer || (entry && this.producer.entry !== entry)) return
    this.process.send({ t: 'cancel' })
    this.dirty = true
    this.endProducer(false)
  }

  /** A new write of a name: the sweep of a draft of that name on this board has no more use. A version in the log is on the board, and its stream plays on. */
  cancelSweepOf(name: string): void {
    const entry = this.producer?.entry
    if (entry && entry.name === name && !this.log.includes(entry) && this.producer?.board === this.boardPath) this.cancelSweep()
  }

  /** Why the stage ended the last program itself (no abort signal: the board window loaded again). */
  private cancelWhy = 'The program was stopped.'

  /**
   * End a running program now: its worker stops, and the stage is rebuilt before the next run. A program of the log that
   * a stop ends while the stage is rebuilt (a program that never ends would hold every later call) is marked, so a later
   * rebuild does not run it again. byUser: false when the program is not at fault (the board window loaded again, an idle rebuild gives way).
   * A sweep is not a program in flight: a call that only waits for it gives up its wait (cancelSweep ends a sweep).
   */
  private cancel(why?: string, byUser = true): void {
    if (!this.process.running || (this.producer && !this.pending.size)) return
    if (byUser && this.rebuilding) this.mark(this.rebuilding, 'it was stopped while the stage was rebuilt')
    if (why) this.cancelWhy = why
    this.process.send({ t: 'cancel' })
    this.failPending(CANCELLED)
    this.dirty = true
  }

  /**
   * The board window loaded (again): its renderer gets a new frames port. A
   * program or a sweep that runs now ends (its frames went to the renderer
   * before), and a program's call fails as cancelled.
   */
  linkBoard(contents: WebContents): void {
    this.boardContents = contents
    this.cancelSweep()
    if (this.pending.size) this.cancel('The board window loaded again while the scene program ran (its frames went to the window before).', false)
    void this.linkFrames()
  }

  /** A new channel between the stage page and the board renderer for frames; resolves when the page has its end. */
  private async linkFrames(): Promise<void> {
    const board = this.boardContents
    if (!this.process.running || !board || board.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    const linked = new Promise<void>((resolve) => this.linkWaiters.push(resolve))
    this.process.sendFramesPort(port1)
    board.postMessage(IPC.framesPort, null, [port2])
    let timer: NodeJS.Timeout | undefined
    await Promise.race([linked, new Promise<void>((resolve) => (timer = setTimeout(resolve, 5000)))])
    clearTimeout(timer)
  }

  /**
   * Run a program on the stage. mode "scene" adds it to the log (record the
   * scene id with entry.scene after the commit, or discard it); "draft"
   * leaves the stage as it was (adoptDraft adds it later). seed and cutAt
   * repeat an earlier run (cut, a draft that plays). place: a new version
   * of a scene (mcp.ts placeAt). While place.entry is in the log (a draft),
   * the program runs on the stage as it was before that program; a restage
   * took it out of the log, so there the end is that place. The board
   * answers the program's requests at the place (place.board). checkOptions:
   * an unknown option of a scene global is an error (a program that write_scene
   * drafts now, never a program that runs again). answers with voice answers
   * (main/voice.ts) make its say() lines ask for them.
   */
  async run(
    source: SceneSource,
    context: SceneContext,
    options: {
      mode: 'scene' | 'draft'
      seed?: number
      cutAt?: number | null
      name?: string | null
      signal?: AbortSignal
      answers?: Map<string, string>
      place?: { entry: StageEntry; board: unknown } | null
      checkOptions?: boolean
    }
  ): Promise<StageRun> {
    const { signal } = options
    if (signal?.aborted) throw new SceneCancelled()
    const before = options.place && this.log.includes(options.place.entry) ? options.place.entry : null
    // A program in the log keeps its place: only a draft runs before it.
    if (before && options.mode !== 'draft') throw new Error('stage.run: a scene runs at a place only after the restage took that place out of the log.')
    this.adopt(context)
    this.lastPlace = before
    const fresh = this.log.length === 0 ? this.freshReason : null
    const seed = options.seed ?? newSeed()
    const tStart = Date.now()
    const onAbort = (): void => this.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensure(before, signal).catch((error: unknown) => {
        throw signal?.aborted ? new SceneCancelled() : error
      })
      // Its stage ids start after the programs before its place (the empty ids of a marked one included).
      const first = this.firstId(before ? this.log.indexOf(before) : this.log.length)
      const saved = { ...context, ...(context.stage ? { stage: { ...context.stage, first } } : {}), seed, cutAt: options.cutAt ?? null }
      // The entry keeps ctxText without checkOptions and voice: a run of this entry from its record gets no check, and its voice comes from its answers.
      const ctxText = JSON.stringify(saved)
      const voice = !!options.answers && voiceAnswers(options.answers).size > 0
      const tReady = Date.now()
      if (signal?.aborted) throw new SceneCancelled()
      const record = new Map<string, string>()
      this.answers = { record, given: options.answers ?? null, place: options.place?.board }
      const job = this.nextId++
      const sent = options.checkOptions || voice ? JSON.stringify({ ...saved, ...(options.checkOptions ? { checkOptions: true } : {}), ...(voice ? { voice: true } : {}) }) : ctxText
      // The entry before the run, so its sweep has it from the early reply on; the reply adds its keys and range.
      const entry: StageEntry = { scene: null, source, name: options.name ?? null, seed, cutAt: options.cutAt ?? null, ctxText, answers: record }
      const reply = await this.send({ t: 'run', id: job, program: stageProgram(source), ctxText: sent, mode: options.mode }, entry)
      // A sweep can still ask the board: its record closes the answers.
      if (!(reply.ok && reply.sweeping)) this.answers = { record: new Map(), given: null }
      const tDone = Date.now()
      console.log(`stage: ${options.mode} program: stage ready ${tReady - tStart} ms, program ${tDone - tReady} ms`)
      if (reply.ok && reply.timing) {
        const t = reply.timing
        console.log(
          `stage: ${options.mode} timing: body ${Math.round(t.body)} ms, seeds ${Math.round(t.seeds)} ms, sampling ${Math.round(t.result)} ms (encode ${Math.round(t.encode)} ms, wait for the board ${Math.round(t.wait)} ms), bake ${Math.round(t.bake)} ms, evaluations ${t.evaluations} of ${t.fullEvaluations}, swept ${t.swept} of ${t.seeded} objects, description ${reply.json?.length ?? 0} chars, frames ${reply.frames} chunks ${(t.bytes / 1024 / 1024).toFixed(2)} MB`
        )
      }
      if (signal?.aborted) throw new SceneCancelled()
      if (!reply.ok && reply.error === CANCELLED) {
        this.dirty = true
        throw new SceneProgramError(this.cancelWhy, null)
      }
      if (!reply.ok) {
        this.dirty = true
        const module = source.modules.find((m) => m.path === reply.file) ?? source.modules[0]
        const lines = module.text.split('\n').length
        // A line after the last one is the end of the program (an unclosed bracket or string).
        let error = reply.line !== null && reply.line > lines ? new SceneProgramError(`At the end of the program: ${reply.error}`, null, reply.file) : new SceneProgramError(reply.error, reply.line, reply.file)
        const missing = /ReferenceError: '?([A-Za-z_$][\w$]*)'? is not defined/.exec(reply.error)?.[1]
        const instead = missing && Object.hasOwn(MISNAMED, missing) ? MISNAMED[missing] : null
        if (instead) error = new SceneProgramError(`ReferenceError: ${missing} is not a scene function. ${instead}`, error.line, error.file)
        else if (fresh && /ReferenceError|not defined|undefined/i.test(reply.error)) error = new SceneProgramError(`${error.detail}\nThe stage is new (${fresh}): nothing made by programs before that is in it.`, error.line, error.file)
        throw error
      }
      if (options.mode === 'draft') this.dirty = true
      let desc: SceneDescription
      try {
        desc = JSON.parse(reply.json as string) as SceneDescription
      } catch (error) {
        this.dirty = true
        throw new SceneProgramError(`The scene could not be read: ${error instanceof Error ? error.message : String(error)}`, null)
      }
      desc.stage = this.epoch
      if (reply.keys) entry.keys = reply.keys
      if (reply.range) entry.range = reply.range
      if (options.mode === 'scene') {
        this.log.push(entry)
        this.held = this.log.length
        this.revision++
        this.freshReason = null
      }
      const timing: Record<string, number> = { stage_ready_ms: tReady - tStart, stage_run_ms: tDone - tReady }
      if (reply.timing) {
        const t = reply.timing
        Object.assign(timing, { body_ms: Math.round(t.body), seeds_ms: Math.round(t.seeds), sampling_ms: Math.round(t.result), encode_ms: Math.round(t.encode), board_wait_ms: Math.round(t.wait), bake_ms: Math.round(t.bake), frames_bytes: t.bytes })
      }
      return { desc, entry, fresh, job, frames: reply.frames, timing, orderDependent: reply.orderDependent }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * The lines pass (decision T34): the texts of the program's say() lines, from a run on the stage
   * where its draft will run, with no sampling and no draft. Every line has the reading pace here. A program that fails throws
   * as in run(). The stage is rebuilt after it.
   */
  async lines(source: SceneSource, context: SceneContext, options: { seed: number; signal: AbortSignal; place?: { entry: StageEntry; board: unknown } | null }): Promise<string[]> {
    const { signal } = options
    if (signal.aborted) throw new SceneCancelled()
    const before = options.place && this.log.includes(options.place.entry) ? options.place.entry : null
    this.adopt(context)
    this.lastPlace = before
    const onAbort = (): void => this.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensure(before, signal).catch((error: unknown) => {
        throw signal.aborted ? new SceneCancelled() : error
      })
      const first = this.firstId(before ? this.log.indexOf(before) : this.log.length)
      const ctxText = JSON.stringify({ ...context, ...(context.stage ? { stage: { ...context.stage, first } } : {}), seed: options.seed, cutAt: null, checkOptions: true })
      if (signal.aborted) throw new SceneCancelled()
      this.answers = { record: new Map(), given: null, place: options.place?.board }
      const reply = await this.send({ t: 'run', id: this.nextId++, program: stageProgram(source), ctxText, mode: 'lines' })
      this.answers = { record: new Map(), given: null }
      this.dirty = true
      if (signal.aborted) throw new SceneCancelled()
      if (!reply.ok) throw new SceneProgramError(reply.error, reply.line, reply.file)
      return JSON.parse(reply.json as string) as string[]
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** A running stage process with its frames port to the board. */
  private async startProcess(): Promise<void> {
    if (this.process.running) return
    try {
      await this.process.start({ t: 'init', fontText: JSON.stringify(HAND_FONT), noCodeItems: NO_CODE_ITEMS, noHtml: NO_HTML })
    } catch (error) {
      throw new SceneProgramError(`The stage could not start: ${error instanceof Error ? error.message : String(error)}`, null)
    }
    this.dirty = true
    await this.linkFrames()
  }

  /** The place of before in the log; the end when it is not in the log. */
  private placeIndex(before: StageEntry | null): number {
    return before && this.log.includes(before) ? this.log.indexOf(before) : this.log.length
  }

  /**
   * A stage process whose context holds exactly the log (before: the programs of the log before that one). Marked programs
   * are skipped. signal: the operation's cancel, checked before each reset and each program. start: false stops at a stopped process (settle).
   */
  private async ensure(before: StageEntry | null = null, signal?: AbortSignal, start = true): Promise<void> {
    await this.ownSweep(signal)
    if (start) await this.startProcess()
    else if (!this.process.running) return
    const upTo = this.placeIndex(before)
    if (this.clean && this.held === upTo) return
    const started = Date.now()
    // A context that holds fewer programs of the log runs on from there (a replay's rebuild sampled up to its scene).
    const from = this.clean && this.held < upTo ? this.held : 0
    if (from === 0) await this.resetContext(signal)
    else this.dirty = true
    let ran = 0
    for (const entry of this.log.slice(from, upTo)) {
      if (entry.failed) continue
      // A program that fails now is marked and keeps its place; the context starts again without it.
      if (!(await this.runAgain(entry, 'replay', signal))) return this.ensure(before, signal, start)
      ran++
    }
    this.dirty = false
    this.held = upTo
    console.log(`stage: rebuilt with ${ran} programs in ${Date.now() - started} ms`)
  }

  /** reply: sends to the stage process that sent the message, and drops the answer when that process stopped since. */
  private onStageMessage(message: FromStage, reply: (answer: ToStage) => void): void {
    if (message.t === 'reply') {
      const resolve = this.pending.get(message.id)
      if (!resolve) {
        // A failed reply after the early reply: the sweep failed.
        if (this.producer?.job === message.id && !message.ok) this.sweepFailed(this.producer, message)
        return
      }
      this.pending.delete(message.id)
      const entry = this.inFlight.get(message.id) ?? null
      this.inFlight.delete(message.id)
      if (message.ok && message.sweeping) {
        let end = (_complete: boolean): void => undefined
        const done = new Promise<boolean>((resolved) => (end = resolved))
        this.producer = { job: message.id, board: this.boardPath, entry, operation: this.operation, done, end }
        this.unbaked = true
      }
      resolve(message)
    } else if (message.t === 'swept') {
      const producer = this.producer
      if (producer?.job !== message.id) return
      console.log(`stage: swept ${producer.entry?.name ?? `job ${message.id}`} on ${producer.board ?? 'no board'} in ${Math.round(message.ms)} ms, ${message.frames} chunks${message.orderDependent.length ? `; order dependent: ${message.orderDependent.join(', ')}` : ''}`)
      const scene = producer.entry?.name ?? 'without a name'
      // A scene baked at its sweep's end; a draft never bakes, and its run left the context dirty.
      this.unbaked = false
      this.endProducer(true, false, [...message.orderDependent.map((object) => `Scene "${scene}": ${object} gave another result in play than in write_scene: its recipe depends on the order of its calls.`), ...message.logs.map((line) => `Scene "${scene}" logged: ${line}`)])
    } else if (message.t === 'host') void this.answerHost(message.hid, message.text, reply)
    else if (message.t === 'linked') {
      const waiters = this.linkWaiters
      this.linkWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /** The sweep threw: its entry keeps the error, the board's stream ends at its cutoff, and the agent gets the error with its place. */
  private sweepFailed(producer: Producer, reply: Extract<StageReply, { ok: false }>): void {
    console.warn(`stage: the sweep of ${producer.entry?.name ?? `job ${reply.id}`} failed: ${reply.error}`)
    const error = `${new SceneProgramError(reply.error, reply.line, reply.file).message}${reply.at !== undefined ? `, at ${Math.round(reply.at * 100) / 100} s of the scene` : ''}`
    if (producer.entry) producer.entry.sweepError = error
    this.dirty = true
    const scene = producer.entry?.name ?? 'without a name'
    // A scene of the log streamed as it played (play_scene start, a replay); a draft streamed after write_scene.
    const note = producer.entry && this.log.includes(producer.entry) ? `Scene "${scene}" failed while its frames streamed: ${error}. It plays to that moment, then shows its end.` : `Scene "${scene}" failed after write_scene returned: ${error}. It plays to that moment, then shows its end. A draft of it cannot start: change it with write_scene.`
    this.endProducer(false, true, [note])
  }

  /** The stage process stopped (a crash, an out-of-memory): what waited on it fails, and the next operation starts a new process and rebuilds the stage (as its own work, which a cancel stops). */
  private onStageGone(why: string, outOfMemory: boolean): void {
    console.warn(`stage: the stage process stopped (${why})`)
    this.failPending(outOfMemory ? TOO_MUCH_MEMORY : `The stage stopped (${why}). The usual cause is a program that uses too much memory. The stage is rebuilt from the programs before it.`)
    this.dirty = true
    this.endProducer(false)
  }

  private failPending(error: string): void {
    for (const [id, resolve] of this.pending) resolve({ t: 'reply', id, ok: false, error, line: null, file: null, ms: 0 })
    this.pending.clear()
    this.inFlight.clear()
  }

  /** Answer a program's question to the board (text sizes; html, space, items and write()'s glyphs, recorded, and given back on a rebuild). */
  private async answerHost(hid: number, text: string, reply: (answer: ToStage) => void): Promise<void> {
    const answers = this.answers
    let answer = '{}'
    try {
      const request = JSON.parse(text) as { kind?: string; items?: TextItem[] }
      if (request.kind === 'text') {
        // Text measures are answers too (recorded, and given back on a rebuild), so a re-run lays text out as the first run did,
        // but only under the same text layout (BOARD_LAYOUT): a measure of another layout is measured again, so the stage's
        // objects (and its size cache, stage/live-prelude.js measureText) only ever hold sizes of the layout the board shows.
        const given = answers.given?.get(text)
        answer = given !== undefined && measureLayout(given) === BOARD_LAYOUT ? given : JSON.stringify({ sizes: await this.textSizes(Array.isArray(request.items) ? request.items : []), layout: BOARD_LAYOUT })
        answers.record.set(text, answer)
      } else if (request.kind === 'voiceLine') {
        // No network here: the run has its voice answers, and a line without one takes the reading pace ({}).
        answer = answers.given?.get(text) ?? '{}'
        answers.record.set(text, answer)
      } else if (request.kind === 'html' || request.kind === 'space' || request.kind === 'item' || request.kind === 'glyphs') {
        const given = answers.given?.get(text)
        if (given !== undefined) answer = given
        else {
          try {
            answer = JSON.stringify(await this.host(request as HostRequest, answers.place))
          } catch (error) {
            answer = JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
          }
        }
        answers.record.set(text, answer)
      }
    } catch {
      answer = '{}'
    }
    // An answer the stage would refuse becomes an error the program sees (it waits for an answer).
    if (answer.length > STAGE_LIMITS.host) answer = JSON.stringify({ error: `The board's answer is ${answer.length} characters; the stage takes at most ${STAGE_LIMITS.host}.` })
    // Host ids start at 1 again in a new process: only the process that asked gets the answer.
    reply({ t: 'answer', hid, text: answer })
  }

  private send(message: { t: 'reset'; id: number } | { t: 'run'; id: number; program: StageProgram; ctxText: string; mode: StageMode }, entry?: StageEntry): Promise<StageReply> {
    if (!this.process.running) return Promise.resolve({ t: 'reply', id: message.id, ok: false, error: 'The stage process stopped.', line: null, file: null, ms: 0 })
    // What the stage would refuse never goes: the call gets the reason now (the stage would answer it too, but later and with less).
    if (message.t === 'run') {
      const tooLarge = programTooLarge(message.program)
      const refused = tooLarge ?? (message.ctxText.length > STAGE_LIMITS.context ? { file: null, message: `The scene's context is ${message.ctxText.length} characters; the stage takes at most ${STAGE_LIMITS.context}.` } : null)
      if (refused) return Promise.resolve({ t: 'reply', id: message.id, ok: false, error: refused.message, line: null, file: refused.file, ms: 0 })
    }
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve)
      if (entry) this.inFlight.set(message.id, entry)
      this.process.send(message)
    })
  }
}
