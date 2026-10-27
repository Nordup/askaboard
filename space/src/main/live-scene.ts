import { MessageChannelMain, type WebContents } from 'electron'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription } from '@shared/live-scene'
import { IPC } from '@shared/space-api'
import type { FromStage, StageMode, StageReply, ToStage } from '@shared/stage-protocol'
import { NO_CODE_ITEMS, NO_HTML } from './lab-switch'
import { StageProcess } from './stage-process'

/**
 * The stage: one long-lived sandbox per board in which every scene program
 * (write_scene, play_scene) runs, so objects, values, helpers and `stage` made by one
 * program are there for the next. The sandbox is a V8 realm in a worker of
 * the stage process, a hidden, sandboxed Chromium renderer (stage-process.ts,
 * stage/worker.ts); the app has one stage process.
 *
 * The stage keeps a log of the programs it ran (code, context, seed). Its
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

export class SceneProgramError extends Error {
  constructor(
    message: string,
    readonly line: number | null
  ) {
    super(line ? `Line ${line}: ${message}` : message)
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

/** One program the stage ran, in order. scene: the renderer's scene id once it is committed. */
export interface StageEntry {
  scene: string | null
  code: string
  name: string | null
  seed: number
  /** The time the scene was cut at (play_scene cut), or null. It is also in ctxText; a run of this entry again (restage, rollback) passes it on. */
  cutAt: number | null
  ctxText: string
  /** The board's answers to the program's host requests (html, image, space, copy), by request: a replay gets the same ones. */
  answers: Map<string, string>
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
}

/** A tex() or text() node to measure: its source, math or not, and its font size. */
export interface TextItem {
  math: boolean
  text: string
  size: number
}

/** A request from the sandbox that the board answers (html(), image(), space(), copy()): plain JSON in and out. */
export type HostRequest = { kind: 'html' | 'space' | 'item' } & Record<string, unknown>

/** The error of a reply that never came, because the program was cancelled. */
const CANCELLED = 'cancelled'
/** The error of a program that ended the stage process by going over V8's heap limit (stage-process.ts, onGone). */
const TOO_MUCH_MEMORY = 'The scene program ran out of memory and was stopped. The stage is rebuilt from the programs before it.'
export class SceneStage {
  /** Measured text sizes (board points) by math, size and source; null: could not be measured. */
  private textCache = new Map<string, [number, number] | null>()
  /** The answers of the program that runs now: recorded (and, for a replay, given back) by request. */
  private answers: { record: Map<string, string>; given: Map<string, string> | null } = { record: new Map(), given: null }

  /**
   * measureText: the renderer lays the text out as the board does (renderer/live/measure.ts).
   * host: the renderer answers html(), image(), space() and copy() requests (renderer/live/host.ts).
   */
  constructor(
    private readonly measureText: (items: TextItem[]) => Promise<Array<[number, number]>>,
    private readonly host: (request: HostRequest) => Promise<unknown>
  ) {
    this.process = new StageProcess(
      (message, reply) => this.onStageMessage(message, reply),
      (why, outOfMemory) => this.onStageGone(why, outOfMemory)
    )
    // Start the stage process and load the scene library now, not in the first scene.
    setTimeout(() => {
      void this.exclusive(() => this.ensure()).catch(() => undefined)
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
    this.dirty = true
  }

  /** Why the stage ended the last program itself (no abort signal: the board window loaded again). */
  private cancelWhy = 'The program was stopped.'

  /** End a running program now: its worker stops, and the stage is rebuilt before the next run. */
  private cancel(why?: string): void {
    if (!this.process.running) return
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
    if (this.pending.size) this.cancel('The board window loaded again while the scene program ran (its frames went to the window before).')
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
   * repeat an earlier run (cut, a draft that plays).
   */
  async run(
    code: string,
    context: SceneContext,
    options: {
      mode: 'scene' | 'draft'
      seed?: number
      cutAt?: number | null
      name?: string | null
      signal?: AbortSignal
      answers?: Map<string, string>
    }
  ): Promise<StageRun> {
    const { signal } = options
    if (signal?.aborted) throw new SceneCancelled()
    this.adopt(context)
    const fresh = this.log.length === 0 ? this.freshReason : null
    const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31) + 1
    const ctxText = JSON.stringify({ ...context, seed, cutAt: options.cutAt ?? null })
    const tStart = Date.now()
    const onAbort = (): void => this.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensure().catch((error: unknown) => {
        throw signal?.aborted ? new SceneCancelled() : error
      })
      const tReady = Date.now()
      if (signal?.aborted) throw new SceneCancelled()
      const record = new Map<string, string>()
      this.answers = { record, given: options.answers ?? null }
      const job = this.nextId++
      const reply = await this.send({ t: 'run', id: job, code, ctxText, mode: options.mode })
      this.answers = { record: new Map(), given: null }
      console.log(`stage: ${options.mode} program: stage ready ${tReady - tStart} ms, program ${Date.now() - tReady} ms`)
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
        const lines = code.split('\n').length
        // A line after the last one is the end of the program (an unclosed bracket or string).
        let error = reply.line !== null && reply.line > lines ? new SceneProgramError(`At the end of the program: ${reply.error}`, null) : new SceneProgramError(reply.error, reply.line)
        const missing = /ReferenceError: '?([A-Za-z_$][\w$]*)'? is not defined/.exec(reply.error)?.[1]
        const instead = missing && Object.hasOwn(MISNAMED, missing) ? MISNAMED[missing] : null
        if (instead) error = new SceneProgramError(`ReferenceError: ${missing} is not a scene function. ${instead}`, error.line)
        else if (fresh && /ReferenceError|not defined|undefined/i.test(reply.error)) error = new SceneProgramError(`${error.message.replace(/^Line \d+: /, '')}\nThe stage is new (${fresh}): nothing made by programs before that is in it.`, error.line)
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
      const entry: StageEntry = { scene: null, code, name: options.name ?? null, seed, cutAt: options.cutAt ?? null, ctxText, answers: record }
      if (options.mode === 'scene') {
        this.log.push(entry)
        this.revision++
        this.freshReason = null
      }
      return { desc, entry, fresh, job, frames: reply.frames }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** A stage process whose context holds exactly the log. */
  private async ensure(): Promise<void> {
    if (!this.process.running) {
      try {
        await this.process.start({ t: 'init', fontText: JSON.stringify(HAND_FONT), noCodeItems: NO_CODE_ITEMS, noHtml: NO_HTML })
      } catch (error) {
        throw new SceneProgramError(`The stage could not start: ${error instanceof Error ? error.message : String(error)}`, null)
      }
      this.dirty = true
      await this.linkFrames()
    }
    if (!this.dirty) return
    const started = Date.now()
    const reset = await this.send({ t: 'reset', id: this.nextId++ })
    if (!reset.ok) throw new SceneProgramError(reset.error, null)
    for (const entry of [...this.log]) {
      this.answers = { record: new Map(), given: entry.answers }
      const reply = await this.send({ t: 'run', id: this.nextId++, code: entry.code, ctxText: entry.ctxText, mode: 'replay' })
      this.answers = { record: new Map(), given: null }
      if (!reply.ok && reply.error === CANCELLED) throw new SceneCancelled()
      if (!reply.ok) {
        // A program that ran before and fails now (it read something that changed, or it stopped the stage process): it leaves the stage.
        console.warn(`stage: a program of scene ${entry.scene ?? '?'} failed when the stage was rebuilt: ${reply.error}`)
        this.log.splice(this.log.indexOf(entry), 1)
        this.revision++
        this.dirty = true
        return this.ensure()
      }
    }
    this.dirty = false
    console.log(`stage: rebuilt with ${this.log.length} programs in ${Date.now() - started} ms`)
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

  /** The stage process stopped (a crash, an out-of-memory): what waited on it fails, and a new process rebuilds the stage. */
  private onStageGone(why: string, outOfMemory: boolean): void {
    console.warn(`stage: the stage process stopped (${why})`)
    this.failPending(outOfMemory ? TOO_MUCH_MEMORY : `The stage stopped (${why}). The usual cause is a program that uses too much memory. The stage is rebuilt from the programs before it.`)
    this.dirty = true
    void this.exclusive(() => this.ensure()).catch(() => undefined)
  }

  private failPending(error: string): void {
    for (const [id, resolve] of this.pending) resolve({ t: 'reply', id, ok: false, error, line: null, ms: 0 })
    this.pending.clear()
  }

  /** Answer a program's question to the board (text sizes; html, space and items, recorded, and given back on a rebuild). */
  private async answerHost(hid: number, text: string, reply: (answer: ToStage) => void): Promise<void> {
    const answers = this.answers
    let answer = '{}'
    try {
      const request = JSON.parse(text) as { kind?: string; items?: TextItem[] }
      if (request.kind === 'text') answer = JSON.stringify({ sizes: await this.textSizes(Array.isArray(request.items) ? request.items : []) })
      else if (request.kind === 'html' || request.kind === 'space' || request.kind === 'item') {
        const given = answers.given?.get(text)
        if (given !== undefined) answer = given
        else {
          try {
            answer = JSON.stringify(await this.host(request as HostRequest))
          } catch (error) {
            answer = JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
          }
        }
        answers.record.set(text, answer)
      }
    } catch {
      answer = '{}'
    }
    // Host ids start at 1 again in a new process: only the process that asked gets the answer.
    reply({ t: 'answer', hid, text: answer })
  }

  private send(message: { t: 'reset'; id: number } | { t: 'run'; id: number; code: string; ctxText: string; mode: StageMode }): Promise<StageReply> {
    if (!this.process.running) return Promise.resolve({ t: 'reply', id: message.id, ok: false, error: 'The stage process stopped.', line: null, ms: 0 })
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve)
      this.process.send(message)
    })
  }
}
