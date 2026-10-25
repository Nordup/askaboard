import { MessageChannel, type MessagePort, type Worker } from 'node:worker_threads'
import createWorker from './live-worker?nodeWorker'
import prelude from './live-prelude.js?raw'
import { HAND_FONT } from '@shared/hand-font'
import type { SceneContext, SceneDescription } from '@shared/live-scene'
import type { WorkerReply, WorkerReset, WorkerRun } from './live-worker'
import { NO_CODE_ITEMS } from './lab-switch'

/**
 * The stage: one long-lived sandbox per board in which every scene program
 * (run_scene) runs, so objects, values, helpers and `stage` made by one
 * program are there for the next (live-worker.ts holds the QuickJS context).
 *
 * The stage keeps a log of the programs it ran (code, context, seed). Its
 * state is always the result of running that log in order, which makes it
 * possible to roll it back: after a program error, a preview, a cancel, a
 * skipped scene, a replaced or cut scene, the context is rebuilt by running
 * the log again (fast: programs only compute).
 * The stage starts new when the board changes, on scene_control reset, and
 * when the app starts.
 */

export class SceneProgramError extends Error {
  constructor(
    message: string,
    readonly line: number | null
  ) {
    super(line ? `Line ${line}: ${message}` : message)
  }
}

/** The program was cancelled (scene_control stop/skip/cancel, or the client went away) before it finished. */
export class SceneCancelled extends Error {
  constructor() {
    super('Cancelled: the scene program was stopped before it finished (scene_control stop, skip or cancel, or the client cancelled the call). Nothing was drawn.')
  }
}

/** One program the stage ran, in order. scene: the renderer's scene id once it is committed. */
export interface StageEntry {
  scene: string | null
  code: string
  name: string | null
  seed: number
  ctxText: string
  /** The board's answers to the program's host requests (html, image, space, copy), by request: a replay gets the same ones. */
  answers: Map<string, string>
}

export interface StageRun {
  desc: SceneDescription
  entry: StageEntry
  /** Set when this program was the first one of a new stage: why the stage is new. */
  fresh: string | null
}

/** A tex() or text() node to measure: its source, math or not, and its font size. */
export interface TextItem {
  math: boolean
  text: string
  size: number
}

/** A request from the sandbox that the board answers (html(), image(), space(), copy()): plain JSON in and out. */
export type HostRequest = { kind: 'html' | 'space' | 'item' } & Record<string, unknown>

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
    // The sandbox's first start is slow (WebAssembly, the scene library): do it now, not in the first scene.
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

  private worker: Worker | null = null
  private port: MessagePort | null = null
  private flag = new SharedArrayBuffer(4)
  private nextId = 1
  private pending = new Map<number, (reply: WorkerReply) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private epochNo = 0
  private boardPath: string | null = null
  /** The worker's context does not match the log (an error, a preview, a cancel): rebuild before the next run. */
  private dirty = true
  /** Why the stage is new, until its first program runs. */
  private freshReason: string | null = 'the app started'
  readonly log: StageEntry[] = []

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

  /** Scenes that will never play (skipped): their programs leave the stage. */
  drop(sceneIds: string[]): void {
    const before = this.log.length
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].scene && sceneIds.includes(this.log[i].scene as string)) this.log.splice(i, 1)
    if (this.log.length !== before) this.dirty = true
  }

  /** Forget a program whose scene was not committed. */
  discard(entry: StageEntry): void {
    const index = this.log.indexOf(entry)
    if (index >= 0) this.log.splice(index, 1)
    this.dirty = true
  }

  /** Keep only the programs before this scene (to run it, and the ones after, again). Returns the programs after it, or null when the scene is not in the log. */
  truncateBefore(sceneId: string): { entry: StageEntry; later: StageEntry[] } | null {
    const index = this.log.findIndex((entry) => entry.scene === sceneId)
    if (index < 0) return null
    const entry = this.log[index]
    const later = this.log.slice(index + 1)
    this.log.length = index
    this.dirty = true
    return { entry, later }
  }

  /** End a running program now: its worker stops, and the stage is rebuilt before the next run. */
  cancelWorker(): void {
    if (!this.worker) return
    void this.worker.terminate()
    this.worker = null
    this.port?.close()
    this.port = null
    for (const resolve of this.pending.values()) resolve({ id: 0, ok: false, error: 'cancelled', line: null, ms: 0 })
    this.pending.clear()
    this.dirty = true
  }

  /**
   * Run a program on the stage. mode "scene" adds it to the log (record the
   * scene id with entry.scene after the commit, or discard it); "preview"
   * leaves the stage as it was. seed and cutAt repeat an earlier run (cut).
   */
  async run(
    code: string,
    context: SceneContext,
    options: { mode: 'scene' | 'preview'; seed?: number; cutAt?: number | null; name?: string | null; signal?: AbortSignal; answers?: Map<string, string> }
  ): Promise<StageRun> {
    const { signal } = options
    if (signal?.aborted) throw new SceneCancelled()
    this.adopt(context)
    const fresh = this.log.length === 0 ? this.freshReason : null
    const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31) + 1
    const ctxText = JSON.stringify({ ...context, seed, cutAt: options.cutAt ?? null })
    const tStart = Date.now()
    const onAbort = (): void => this.cancelWorker()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensure().catch((error: unknown) => {
        throw signal?.aborted ? new SceneCancelled() : error
      })
      const tReady = Date.now()
      if (signal?.aborted) throw new SceneCancelled()
      const record = new Map<string, string>()
      this.answers = { record, given: options.answers ?? null }
      const reply = await this.send({ type: 'run', id: this.nextId++, code, ctxText, mode: options.mode })
      this.answers = { record: new Map(), given: null }
      console.log(`stage: ${options.mode} program: stage ready ${tReady - tStart} ms, program ${Date.now() - tReady} ms`)
      if (signal?.aborted) throw new SceneCancelled()
      if (!reply.ok) {
        this.dirty = true
        const lines = code.split('\n').length
        // A line after the last one is the end of the program (an unclosed bracket or string).
        let error = reply.line !== null && reply.line > lines ? new SceneProgramError(`At the end of the program: ${reply.error}`, null) : new SceneProgramError(reply.error, reply.line)
        if (fresh && /ReferenceError|not defined|undefined/i.test(reply.error)) error = new SceneProgramError(`${error.message.replace(/^Line \d+: /, '')}\nThe stage is new (${fresh}): nothing made by programs before that is in it.`, error.line)
        throw error
      }
      if (options.mode === 'preview') this.dirty = true
      let desc: SceneDescription
      try {
        desc = JSON.parse(reply.json as string) as SceneDescription
      } catch (error) {
        this.dirty = true
        throw new SceneProgramError(`The scene could not be read: ${error instanceof Error ? error.message : String(error)}`, null)
      }
      desc.stage = this.epoch
      const entry: StageEntry = { scene: null, code, name: options.name ?? null, seed, ctxText, answers: record }
      if (options.mode === 'scene') {
        this.log.push(entry)
        this.freshReason = null
      }
      return { desc, entry, fresh }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** A worker whose context holds exactly the log. */
  private async ensure(): Promise<void> {
    if (!this.worker) this.start()
    if (!this.dirty) return
    const reset = await this.send({ type: 'reset', id: this.nextId++ })
    if (!reset.ok) throw new SceneProgramError(reset.error, null)
    for (const entry of [...this.log]) {
      this.answers = { record: new Map(), given: entry.answers }
      const reply = await this.send({ type: 'run', id: this.nextId++, code: entry.code, ctxText: entry.ctxText, mode: 'replay' })
      this.answers = { record: new Map(), given: null }
      if (!reply.ok) {
        // A program that ran before and fails now (it read something that changed): it leaves the stage.
        console.warn(`stage: a program of scene ${entry.scene ?? '?'} failed when the stage was rebuilt: ${reply.error}`)
        this.log.splice(this.log.indexOf(entry), 1)
        this.dirty = true
        return this.ensure()
      }
    }
    this.dirty = false
  }

  private start(): void {
    const channel = new MessageChannel()
    this.port = channel.port1
    const flag = new Int32Array(this.flag)
    channel.port1.on('message', (raw: unknown) => {
      void (async () => {
        let answer = '{}'
        try {
          const request = JSON.parse(String(raw)) as { kind?: string; items?: TextItem[] }
          if (request.kind === 'text') answer = JSON.stringify({ sizes: await this.textSizes(request.items ?? []) })
          else if (request.kind === 'html' || request.kind === 'space' || request.kind === 'item') {
            const key = String(raw)
            const given = this.answers.given?.get(key)
            if (given !== undefined) answer = given
            else {
              try {
                answer = JSON.stringify(await this.host(request as HostRequest))
              } catch (error) {
                answer = JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
              }
            }
            this.answers.record.set(key, answer)
          }
        } catch {
          answer = '{}'
        }
        channel.port1.postMessage(answer)
        Atomics.store(flag, 0, 1)
        Atomics.notify(flag, 0)
      })()
    })
    const worker = createWorker({ workerData: { prelude, fontText: JSON.stringify(HAND_FONT), noCodeItems: NO_CODE_ITEMS, port: channel.port2, flag: this.flag }, transferList: [channel.port2] })
    worker.on('message', (reply: WorkerReply) => {
      const resolve = this.pending.get(reply.id)
      if (!resolve) return
      this.pending.delete(reply.id)
      resolve(reply)
    })
    const fail = (message: string): void => {
      if (this.worker !== worker) return
      this.worker = null
      this.dirty = true
      for (const resolve of this.pending.values()) resolve({ id: 0, ok: false, error: message, line: null, ms: 0 })
      this.pending.clear()
    }
    worker.on('error', (error) => fail(`The sandbox failed: ${error.message}`))
    worker.on('exit', (code) => fail(`The sandbox stopped (exit code ${code}).`))
    this.worker = worker
    this.dirty = true
  }

  private send(message: WorkerRun | WorkerReset): Promise<WorkerReply> {
    const worker = this.worker
    if (!worker) return Promise.resolve({ id: message.id, ok: false, error: 'cancelled', line: null, ms: 0 })
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve)
      worker.postMessage(message)
    })
  }
}
