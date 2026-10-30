import { MessageChannelMain, type WebContents } from 'electron'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription } from '@shared/live-scene'
import { IPC } from '@shared/space-api'
import { siteLabel, type SceneSource, type StageProgram } from '@shared/scene-program'
import { programTooLarge, STAGE_LIMITS, type FromStage, type StageMode, type StageReply, type ToStage } from '@shared/stage-protocol'
import { NO_CODE_ITEMS, NO_HTML } from './lab-switch'
import { stageProgram } from './scene-files'
import { StageProcess } from './stage-process'

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
 * when the board has every chunk.
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
}

export interface StageRun {
  /** The description without the samples: an object with samples says how many (its frames are in the board renderer). */
  desc: SceneDescription
  entry: StageEntry
  /** Set when this program was the first one of a new stage: why the stage is new. */
  fresh: string | null
  /** The frames of this run in the board renderer: their job id and their number of chunks (renderer/live/frames.ts). */
  job: number
  frames: number
  /** Where the run's time went, in ms (the session trace's spans): stage_ready_ms (a new process or a rebuild first), stage_run_ms, and the stage's own parts. */
  timing: Record<string, number>
}

/** A tex() or text() node to measure: its source, math or not, and its font size. */
export interface TextItem {
  math: boolean
  text: string
  size: number
}

/** A request from the sandbox that the board answers (html(), image(), space(), copy()): plain JSON in and out. */
export type HostRequest = { kind: 'html' | 'space' | 'item' | 'glyphs' } & Record<string, unknown>

/** The error of a reply that never came, because the program was cancelled. */
const CANCELLED = 'cancelled'
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
   */
  constructor(
    private readonly measureText: (items: TextItem[]) => Promise<Array<[number, number]>>,
    private readonly host: (request: HostRequest, place: unknown) => Promise<unknown>
  ) {
    this.process = new StageProcess(
      (message, reply) => this.onStageMessage(message, reply),
      (why, outOfMemory) => this.onStageGone(why, outOfMemory)
    )
    // Start the stage process and load the scene library now, not in the first scene (a log restored by then is rebuilt by its own operation).
    setTimeout(() => {
      void this.exclusive(async () => (this.log.length ? undefined : this.ensure())).catch(() => undefined)
    }, 3000)
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

  /** Run fn with the stage to itself (programs, commits and restaging never interleave). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
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
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].scene && sceneIds.includes(this.log[i].scene as string)) this.log.splice(i, 1)
    if (this.log.length !== before) {
      this.dirty = true
      this.revision++
    }
  }

  /** Forget a program whose scene was not committed. */
  discard(entry: StageEntry): void {
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
    return !this.dirty && this.held === this.placeIndex(this.lastPlace)
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
   * restart (main/mcp.ts ensureMemories). onRun gets each sampled run before the next program runs. A
   * program that fails, or that onRun marks (its re-run does not match its record), changes the context:
   * the run starts again without it. The other programs run as a rebuild. At the end the context holds
   * the whole log. signal cancels it. Runs inside exclusive.
   */
  async resample(wanted: ReadonlySet<StageEntry>, onRun: (entry: StageEntry, run: { desc: SceneDescription; job: number; frames: number }) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.withSignal(signal, async () => {
      const started = Date.now()
      const done = new Set<StageEntry>()
      let sampled = 0
      for (let again = true; again; ) {
        again = false
        await this.startProcess()
        await this.resetContext(signal)
        for (const entry of this.log) {
          if (entry.failed) continue
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
          await onRun(entry, { desc, job: ran.job, frames: ran.frames })
          if (signal?.aborted) throw new SceneCancelled()
          if (entry.failed) {
            again = true
            break
          }
        }
      }
      this.dirty = false
      this.held = this.log.length
      console.log(`stage: ran ${this.log.length} programs again and sampled ${sampled} in ${Date.now() - started} ms`)
    })
  }

  /** A new, empty context in the stage process (a cancel ends this operation first: it never goes on to run the log). */
  private async resetContext(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SceneCancelled()
    const reset = await this.send({ t: 'reset', id: this.nextId++ })
    if (signal?.aborted) throw new SceneCancelled()
    if (!reset.ok) throw new SceneProgramError(reset.error, null)
    this.dirty = true
  }

  /**
   * A program of the log runs again on its saved context (savedContext), as a rebuild ("replay") or sampled ("scene"), at its
   * own stage ids (StageEntry.range). A failure, or a run that takes other stage ids, marks it and returns null. A program
   * whose record has no range runs at the end of the ranges before it; when a marked program before it has none either,
   * that place is not known, and it is marked. A cancel throws SceneCancelled and never marks a program that was not
   * running (a program a cancel stops while it runs is marked: see cancel).
   */
  private async runAgain(entry: StageEntry, mode: 'replay' | 'scene', signal?: AbortSignal): Promise<{ json: string | null; job: number; frames: number } | null> {
    if (signal?.aborted) throw new SceneCancelled()
    const index = this.log.indexOf(entry)
    if (!entry.range && this.log.slice(0, index).some((before) => before.failed && !before.range)) {
      this.mark(entry, 'a scene before it could not run, and its record does not say which stage ids it had')
      return null
    }
    let ctxText: string
    try {
      const ctx = this.savedContext(entry)
      ctxText = JSON.stringify({ ...ctx, stage: { ...ctx.stage, first: entry.range?.[0] ?? this.firstId(index) } })
    } catch (error) {
      this.mark(entry, `its saved context cannot be read (${error instanceof Error ? error.message : String(error)})`)
      return null
    }
    const job = this.nextId++
    this.answers = { record: new Map(), given: entry.answers }
    this.rebuilding = entry
    let reply: StageReply
    try {
      reply = await this.send({ t: 'run', id: job, program: stageProgram(entry.source), ctxText, mode })
    } finally {
      this.answers = { record: new Map(), given: null }
      this.rebuilding = null
    }
    if ((!reply.ok && reply.error === CANCELLED) || signal?.aborted) throw new SceneCancelled()
    if (!reply.ok) {
      // A program that ran before and fails now (its code is gone, it read something that changed, or it stopped the stage process).
      this.mark(entry, reply.error)
      return null
    }
    if (entry.range && (reply.range?.[0] !== entry.range[0] || reply.range[1] !== entry.range[1])) {
      this.mark(entry, `its re-run took the stage ids ${reply.range?.join('–')}, not ${entry.range.join('–')}`)
      return null
    }
    entry.keys = reply.keys ?? []
    entry.range = reply.range ?? undefined
    return { json: reply.json, job, frames: reply.frames }
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

  /** Why the stage ended the last program itself (no abort signal: the board window loaded again). */
  private cancelWhy = 'The program was stopped.'

  /**
   * End a running program now: its worker stops, and the stage is rebuilt before the next run. A program of the log that
   * a stop ends while the stage is rebuilt (a program that never ends would hold every later call) is marked, so a later
   * rebuild does not run it again. byUser: false when the program is not at fault (the board window loaded again, an idle rebuild gives way).
   */
  private cancel(why?: string, byUser = true): void {
    if (!this.process.running) return
    if (byUser && this.rebuilding) this.mark(this.rebuilding, 'it was stopped while the stage was rebuilt')
    if (why) this.cancelWhy = why
    this.process.send({ t: 'cancel' })
    this.failPending(CANCELLED)
    this.dirty = true
  }

  /**
   * The board window loaded (again): its renderer gets a new frames port. A
   * program that runs now ends (its frames went to the renderer before), and
   * its call fails as cancelled.
   */
  linkBoard(contents: WebContents): void {
    this.boardContents = contents
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
   * answers the program's requests at the place (place.board).
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
    const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31) + 1
    const tStart = Date.now()
    const onAbort = (): void => this.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensure(before, signal).catch((error: unknown) => {
        throw signal?.aborted ? new SceneCancelled() : error
      })
      // Its stage ids start after the programs before its place (the empty ids of a marked one included).
      const first = this.firstId(before ? this.log.indexOf(before) : this.log.length)
      const ctxText = JSON.stringify({ ...context, ...(context.stage ? { stage: { ...context.stage, first } } : {}), seed, cutAt: options.cutAt ?? null })
      const tReady = Date.now()
      if (signal?.aborted) throw new SceneCancelled()
      const record = new Map<string, string>()
      this.answers = { record, given: options.answers ?? null, place: options.place?.board }
      const job = this.nextId++
      const reply = await this.send({ t: 'run', id: job, program: stageProgram(source), ctxText, mode: options.mode })
      this.answers = { record: new Map(), given: null }
      const tDone = Date.now()
      console.log(`stage: ${options.mode} program: stage ready ${tReady - tStart} ms, program ${tDone - tReady} ms`)
      if (reply.ok && reply.timing) {
        const t = reply.timing
        console.log(
          `stage: ${options.mode} timing: body ${Math.round(t.body)} ms, sampling ${Math.round(t.result)} ms (encode ${Math.round(t.encode)} ms, wait for the board ${Math.round(t.wait)} ms), bake ${Math.round(t.bake)} ms, evaluations ${t.evaluations} of ${t.fullEvaluations}, description ${reply.json?.length ?? 0} chars, frames ${reply.frames} chunks ${(t.bytes / 1024 / 1024).toFixed(2)} MB`
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
      const entry: StageEntry = { scene: null, source, name: options.name ?? null, seed, cutAt: options.cutAt ?? null, ctxText, answers: record, ...(reply.keys ? { keys: reply.keys } : {}), ...(reply.range ? { range: reply.range } : {}) }
      if (options.mode === 'scene') {
        this.log.push(entry)
        this.held = this.log.length
        this.revision++
        this.freshReason = null
      }
      const timing: Record<string, number> = { stage_ready_ms: tReady - tStart, stage_run_ms: tDone - tReady }
      if (reply.timing) {
        const t = reply.timing
        Object.assign(timing, { body_ms: Math.round(t.body), sampling_ms: Math.round(t.result), encode_ms: Math.round(t.encode), board_wait_ms: Math.round(t.wait), bake_ms: Math.round(t.bake), frames_bytes: t.bytes })
      }
      return { desc, entry, fresh, job, frames: reply.frames, timing }
    } finally {
      signal?.removeEventListener('abort', onAbort)
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
    if (start) await this.startProcess()
    else if (!this.process.running) return
    const upTo = this.placeIndex(before)
    if (!this.dirty && this.held === upTo) return
    const started = Date.now()
    await this.resetContext(signal)
    let ran = 0
    for (const entry of this.log.slice(0, upTo)) {
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
      if (!resolve) return
      this.pending.delete(message.id)
      resolve(message)
    } else if (message.t === 'host') void this.answerHost(message.hid, message.text, reply)
    else if (message.t === 'linked') {
      const waiters = this.linkWaiters
      this.linkWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /** The stage process stopped (a crash, an out-of-memory): what waited on it fails, and the next operation starts a new process and rebuilds the stage (as its own work, which a cancel stops). */
  private onStageGone(why: string, outOfMemory: boolean): void {
    console.warn(`stage: the stage process stopped (${why})`)
    this.failPending(outOfMemory ? TOO_MUCH_MEMORY : `The stage stopped (${why}). The usual cause is a program that uses too much memory. The stage is rebuilt from the programs before it.`)
    this.dirty = true
  }

  private failPending(error: string): void {
    for (const [id, resolve] of this.pending) resolve({ t: 'reply', id, ok: false, error, line: null, file: null, ms: 0 })
    this.pending.clear()
  }

  /** Answer a program's question to the board (text sizes; html, space, items and write()'s glyphs, recorded, and given back on a rebuild). */
  private async answerHost(hid: number, text: string, reply: (answer: ToStage) => void): Promise<void> {
    const answers = this.answers
    let answer = '{}'
    try {
      const request = JSON.parse(text) as { kind?: string; items?: TextItem[] }
      if (request.kind === 'text') {
        // Text measures are answers too (recorded, and given back on a rebuild), so a re-run lays text out as the first run did.
        answer = answers.given?.get(text) ?? JSON.stringify({ sizes: await this.textSizes(Array.isArray(request.items) ? request.items : []) })
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

  private send(message: { t: 'reset'; id: number } | { t: 'run'; id: number; program: StageProgram; ctxText: string; mode: StageMode }): Promise<StageReply> {
    if (!this.process.running) return Promise.resolve({ t: 'reply', id: message.id, ok: false, error: 'The stage process stopped.', line: null, file: null, ms: 0 })
    // What the stage would refuse never goes: the call gets the reason now (the stage would answer it too, but later and with less).
    if (message.t === 'run') {
      const tooLarge = programTooLarge(message.program)
      const refused = tooLarge ?? (message.ctxText.length > STAGE_LIMITS.context ? { file: null, message: `The scene's context is ${message.ctxText.length} characters; the stage takes at most ${STAGE_LIMITS.context}.` } : null)
      if (refused) return Promise.resolve({ t: 'reply', id: message.id, ok: false, error: refused.message, line: null, file: refused.file, ms: 0 })
    }
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve)
      this.process.send(message)
    })
  }
}
