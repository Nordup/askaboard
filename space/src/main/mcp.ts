import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, ipcMain, type WebContents } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MAX_COORD, MAX_NAME_CHARS, MAX_REGION_SIZE } from '@shared/limits'
import { briefText, guideText, guideTopics, serverInstructions } from './guide'
import { codeItems, htmlMaterial, NO_HTML } from './lab-switch'
import { SceneCancelled, SceneProgramError, SceneStage, type StageEntry, type StageRun } from './live-scene'
import type { DraftInfo, FrameMoment, FramePart, SceneContext, SceneDescription, SceneLiveObject, SceneResult } from '@shared/live-scene'
import { renderStoryboard, storyboardScale, type StoryboardInput } from './storyboard'
import { BoardNews } from './news'
import { BoardIndex, findText as boardsFindText, listText as boardsListText, resolveBoard, type OpenBoardInfo } from './boards'
import type { FolderSession } from './folder'
import { readSceneSource } from './scene-files'
import { SceneStore, type RestorableScene } from './scene-store'
import { siteLabel, type SceneSource } from '@shared/scene-program'
import { getAgentLook } from './state'
import type { SnapshotRenderer } from './snapshot'
import { SessionTrace, writeLearnerEdit } from './trace'
import type { LearnerEditDelta } from '@shared/learner-edit'
import {
  IPC,
  type AgentActivity,
  type AgentToolName,
  type AgentMethod,
  type AgentMethods,
  type LiveStillsItem,
  type AgentReply,
  type AgentServerStatus,
  type AgentSessionInfo,
  type SceneEvent
} from '@shared/space-api'
import type { SceneItem } from '@shared/live-scene'

/**
 * The MCP server for external agents (Codex, Claude Code). Streamable HTTP on
 * 127.0.0.1 only, path /mcp. One McpServer and one transport per session, so
 * several agents can connect at once; each session has its own change cursor
 * per board.
 *
 * Safety without a token: the socket binds to loopback, every request must
 * name 127.0.0.1:<port> or localhost:<port> as its Host (DNS rebinding), and a
 * request with an Origin header (a web page) is refused (CSRF).
 *
 * GET /news?client=<label> is the one other route: the board news line for
 * that agent app (see news.ts), as plain text, empty when nothing is new. It
 * changes no board, marks the news delivered, and passes the same Host and
 * Origin checks.
 */

export const DEFAULT_MCP_PORT = 47821
const BRIDGE_TIMEOUT_MS = 10_000
/** The board news is a small in-memory scan; a busy window must not hold a tool result or a prompt hook long. */
const NEWS_TIMEOUT_MS = 1500
/** Writes can download images first. */
const WRITE_TIMEOUT_MS = 45_000
/** A large scene can take a while to turn into board items; this only frees a renderer that never answers. */
/** Scenes have no cap on their size: the board takes as long as it needs to compile one. */
const SCENE_TIMEOUT_MS = Infinity
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** A session with no open stream and no request for this long is closed. */
const IDLE_SESSION_MS = 10 * 60_000
const PRUNE_INTERVAL_MS = 30_000
const PUBLISH_THROTTLE_MS = 2000

export interface AgentServerHooks {
  /** Draws pixel screenshots (content and ink). */
  snapshots: SnapshotRenderer
  /** The window that owns the live board, or null when it is closed. */
  webContents(): WebContents | null
  status(status: AgentServerStatus): void
  activity(activity: AgentActivity): void
  /** The open learning folder's real path, for its `.learning-space/` overrides. */
  folderRoot(): string | null
  /** The board the window shows (folder-relative path), or null; for the session trace. */
  shownBoard(): string | null
  /** The open learning folder, for list_boards, open_board and move_board; null when none is open. */
  folder(): FolderSession | null
  /** The server listens on its port (it owns the port; another instance does not). */
  listening?(): void
}

/** What the MCP SDK passes a tool handler besides its arguments (the part used here). */
type ToolExtra = { signal?: AbortSignal }

interface Session {
  id: string
  server: McpServer
  transport: StreamableHTTPServerTransport
  connectedAt: number
  lastActivity: number
  /** Open GET (server-to-client SSE) streams. A connected client keeps one open. */
  openStreams: number
  /** The change cursor per board path. */
  cursors: Map<string, number>
  /** The session trace (see trace.ts); opened when the client says who it is. */
  trace?: SessionTrace
}

function configuredPort(): number {
  const raw = process.env.SPACE_MCP_PORT
  if (!raw) return DEFAULT_MCP_PORT
  const port = Number(raw)
  if (Number.isInteger(port) && port > 0 && port < 65536) return port
  console.error(`mcp: SPACE_MCP_PORT="${raw}" is not a valid port; using ${DEFAULT_MCP_PORT}`)
  return DEFAULT_MCP_PORT
}

/** Where the app spent a tool call's time (ms) and the scene it started: the session trace's spans (trace.ts). */
type Spans = Record<string, number | string | null>
/** What a tool body adds to its trace line: more args (args) and its spans. */
type CallTrace = { args?: Record<string, unknown>; spans: Spans }

// ---------- The main <-> renderer bridge ----------

class RendererBridge {
  private nextId = 1
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | undefined }>()

  constructor(private readonly target: () => WebContents | null) {
    ipcMain.on(IPC.agentReply, (_event, reply: AgentReply) => {
      const entry = reply && this.pending.get(reply.requestId)
      if (!entry) return
      this.pending.delete(reply.requestId)
      clearTimeout(entry.timer)
      if (reply.ok) entry.resolve(reply.result)
      else entry.reject(new Error(reply.error))
    })
  }

  request<M extends AgentMethod>(method: M, params: AgentMethods[M]['params'], timeoutMs = BRIDGE_TIMEOUT_MS): Promise<AgentMethods[M]['result']> {
    const contents = this.target()
    if (!contents || contents.isDestroyed()) {
      return Promise.reject(new Error('The Learning Space window is closed. Ask the learner to open it.'))
    }
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      // An infinite timeout waits as long as the work takes (scenes: no cap on their size).
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending.delete(requestId)
            reject(new Error(`Learning Space did not answer "${method}" within ${timeoutMs / 1000} s. The window may be loading or busy.`))
          }, timeoutMs)
        : undefined
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer })
      contents.send(IPC.agentRequest, { requestId, method, params })
    })
  }
}

// ---------- Tool results ----------

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
}

/** Tool results are read by programs and agents, never by a person: compact JSON, no indentation. */
const json = (value: unknown): string => JSON.stringify(value)

/** A scene as the agent names it: its name (a replay says so), else its id. */
function sceneLabel(id: unknown, name: unknown): string | null {
  if (typeof id !== 'string') return null
  if (typeof name !== 'string' || !name) return id
  return /~r\d+$/.test(id) ? `${name} (replay)` : name
}

/** play_scene's status as the agent sees it: scenes by name (the renderer adds ids and fields for the main process). */
function publicStatus(status: unknown): Record<string, unknown> {
  const { waiting: _waiting, playing_scene: _playing, board_id: _board, scene, name, paused_scene, paused_name, queue, ...rest } = (status ?? {}) as Record<string, unknown>
  const { playing, t, duration, step, paused, paused_by, paused_step, paused_t, ...other } = rest
  return {
    playing,
    scene: sceneLabel(scene, name),
    t,
    duration_s: duration,
    step,
    paused,
    ...(paused_by !== undefined ? { paused_by, paused_scene: sceneLabel(paused_scene, paused_name), paused_step, paused_t } : {}),
    queue: Array.isArray(queue) ? queue.map((entry: { scene: string; name: string | null; duration_s: number }) => ({ scene: sceneLabel(entry.scene, entry.name), duration_s: entry.duration_s })) : [],
    ...other
  }
}

/** play_scene start's items: how many by kind, and the named ones with their ids (the same shape as write_scene's items, plus ids). */
/** Above this many named items, a scene result gives their names by step and kind instead of one entry each. */
const NAMED_SUMMARY_AT = 25

type NamedItem = { name: string; kind: string; id?: string; step?: string }

/**
 * A tool's input schema that refuses unknown parameters. A plain object schema drops them
 * without a word, so a wrong name (find for query) ran the call as if it was not given.
 */
function strictInput<S extends z.ZodRawShape>(tool: string, shape: S) {
  const names = Object.keys(shape)
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `${tool} has no parameter ${(issue as { keys: string[] }).keys.map((key) => JSON.stringify(key)).join(', ')}. ${names.length ? `Its parameters: ${names.join(', ')}.` : 'It takes no parameters.'}`
        : undefined
  })
}

/**
 * The named items of a scene result: one entry each, or with many, their names by step and
 * kind (no ids), with the call that lists each one. Nothing is left out.
 */
function namedOut(named: NamedItem[], deeper: string): NamedItem[] | { count: number; by_step: Record<string, Record<string, string[]>>; each: string } {
  if (named.length <= NAMED_SUMMARY_AT) return named
  const byStep: Record<string, Record<string, string[]>> = {}
  for (const item of named) {
    const step = item.step ?? '(no step)'
    const kinds = (byStep[step] ??= {})
    ;(kinds[item.kind] ??= []).push(item.name)
  }
  return { count: named.length, by_step: byStep, each: deeper }
}

function itemsSummary(items: SceneItem[], scene: string): { total: number; by_kind: Record<string, number>; named: ReturnType<typeof namedOut> } {
  const byKind: Record<string, number> = {}
  const named: NamedItem[] = []
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    if (item.name) named.push({ name: item.name, kind: item.kind, id: item.id, ...(item.step ? { step: item.step } : {}) })
  }
  return { total: items.length, by_kind: byKind, named: namedOut(named, `list_items({part: {scene: ${JSON.stringify(scene)}}}) lists each with its id`) }
}

/** A change interval handle "c115-c1115" as seqs (c0: everything, below the seq 0 of files that carry none). */
function parseInterval(handle: string): { from: number; to: number } {
  const match = /^c(\d+)-c(\d+)$/.exec(handle.trim())
  if (!match) throw new Error(`"${handle}" is not a change interval. Intervals look like "c115-c1115"; get_changes returns them.`)
  const from = Number(match[1])
  const to = Number(match[2])
  if (to < from) throw new Error(`The change interval "${handle}" ends before it starts.`)
  return { from: from === 0 ? -1 : from, to }
}

/** The play_scene actions besides start (see the play_scene tool). */
const PLAY_ACTIONS = ['start', 'status', 'pause', 'resume', 'next', 'stop', 'clear_queue', 'cancel', 'replay', 'cut', 'reset'] as const
/** At most this many moments in one preview_scene list. */
const MAX_PREVIEW_FRAMES = 12
/** The longest side of a one-frame preview, in pixels. */
const SINGLE_FRAME_EDGE = 1024

/** A draft scene (write_scene): its program, and its run on the stage and board as they were then. Its frames and its compile are in the renderer, under draftKey(desc). */
interface Draft {
  name: string
  /** The program's snapshot (main/scene-files.ts): every run of the draft runs it; the files are not read again. */
  source: SceneSource
  desc: SceneDescription
  /** The run, ready to join the stage's log when it plays unchanged (its seed is kept when it runs again). */
  entry: StageEntry
  fresh: string | null
  revision: number
  contextKey: string
  /** The order of the write_scene calls: a draft never takes the place of a newer one. */
  seq: number
  /** What the board's compile found (write_scene's result). */
  info: DraftInfo
}

/** Where a new version of a scene runs (AgentServer.placeAt): the program of the log it runs before, and the scenes the board leaves out (renderer ScenePlace). */
interface StagePlace {
  entry: StageEntry
  board: { scenes: Array<{ id: string; name: string }> }
}

/** The frames preview_scene draws (renderer sceneFrames). */
type FramesResult = StoryboardInput & { scene: string; duration_s: number; live: LiveStillsItem[] }

/**
 * The key of each version of a draft. The renderer keeps the compile of a
 * draft under its key (renderer/live/run.ts), so the description (megabytes
 * for a big scene) goes to the renderer once, at write_scene. Later calls
 * name the draft by its key.
 */
const draftKeys = new WeakMap<SceneDescription, string>()
let draftCount = 0
function draftKey(desc: SceneDescription): string {
  let key = draftKeys.get(desc)
  if (!key) draftKeys.set(desc, (key = `draft-${++draftCount}`))
  return key
}

/** At most this many live code checks at once (each one runs the code in a host of its own). */
const LIVE_CHECKS = 3

const contextKey = (context: SceneContext): string => JSON.stringify(context)

/** The code items of a description, to check them. */
type LiveCheck = Pick<SceneLiveObject, 'api' | 'mode' | 'code' | 'params' | 'width' | 'height' | 'line' | 'file'>
const livesOf = (desc: SceneDescription): LiveCheck[] => desc.objects.filter((object): object is SceneLiveObject => object.kind === 'live')

const isMissing = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { draftMissing?: unknown }).draftMissing === true

/** Why a draft must run again before it is shown or played (the stage or the board changed since it ran), or null. */
function draftStale(draft: Draft, stage: SceneStage, context: SceneContext | null): string | null {
  if (draft.desc.stage !== stage.epoch) return 'the stage started new'
  if (draft.revision !== stage.revision) return 'other scenes were played, replaced or dropped'
  if (context && contextKey(context) !== draft.contextKey) return "the board or the learner's view changed"
  return null
}

/** A readable name for an MCP client (the agent pill and learner news). */
function clientLabel(raw: string | undefined): string {
  const name = (raw ?? '').toLowerCase()
  if (name.includes('claude')) return 'Claude Code'
  if (name.includes('codex')) return 'Codex'
  if (name.includes('cursor')) return 'Cursor'
  return raw && raw.length <= 24 ? raw : 'Agent'
}

/** A board coordinate or offset (z.number() already refuses NaN and Infinity). */
const coord = (): z.ZodNumber =>
  z.number().min(-MAX_COORD, `Coordinates must be within ±${MAX_COORD} board points.`).max(MAX_COORD, `Coordinates must be within ±${MAX_COORD} board points.`)
/** A width or height in board points. */
const boxSize = (max: number): z.ZodNumber => z.number().positive().max(max, `Sizes must be at most ${max} board points.`)
const rectSchema = z.object({
  x: coord().describe('Left edge, board points'),
  y: coord().describe('Top edge, board points'),
  width: boxSize(MAX_REGION_SIZE),
  height: boxSize(MAX_REGION_SIZE)
})
/** One address for list_items and get_screenshot (docs/learning-space/drafts/board-tools-redesign-2026-10-27.md, section 10). */
const partForms = [
  z.string().min(1),
  z.object({ region: rectSchema }).strict(),
  z.object({ id: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }).strict(),
  z.object({ scene: z.string().min(1), step: z.union([z.number().int().min(1), z.string().min(1)]).optional() }).strict()
] as const
/** get_item's forms; "html" only with HTML material (lab switch LS_LAB_NO_HTML). */
const ITEM_FORMS = (NO_HTML ? ['info', 'svg', 'strokes', 'points', 'source'] : ['info', 'html', 'svg', 'strokes', 'points', 'source']) as [string, ...string[]]

// ---------- The server ----------

export class AgentServer {
  /** Scene programs still running (write_scene, play_scene start), with their session id. */
  private readonly programs = new Map<AbortController, string>()
  /** The order of write_scene calls (Draft.seq). */
  private draftSeq = 0
  /** Draft scenes (write_scene) per board path, by name: the newest ready version. In memory only: they are lost when the app quits. */
  private readonly drafts = new Map<string, Map<string, Draft>>()
  /** The sandbox every scene program runs in, kept between programs (see live-scene.ts). */
  private readonly stage = new SceneStage(
    async (items) => (await this.bridge.request('measureText', { items })).sizes,
    async (request, place) => this.bridge.request('sceneHost', { request, ...(place ? { place } : {}) }, WRITE_TIMEOUT_MS)
  )
  readonly port = configuredPort()
  private readonly bridge: RendererBridge
  private readonly sessions = new Map<string, Session>()
  private http: Server | null = null
  private state: AgentServerStatus['state'] = 'starting'
  private error: string | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private publishTimer: NodeJS.Timeout | null = null
  private lastPublish = 0
  private readonly news: BoardNews
  /** The cache of board summaries and texts for list_boards, open_board and move_board (boards.ts). */
  private readonly boardIndex = new BoardIndex()
  /** The session that started each scene (scene id → session id): its trace gets the scene's playback events. */
  private readonly sceneTraces = new Map<string, SessionTrace>()
  /** The scene records of the boards (scene-store.ts): the only writer. */
  readonly records: SceneStore
  /** The folder, board and board mount whose stage restoreStage last made from the records (restoreMark). */
  private restoredFor: string | null = null
  /** Board mounts in the window (an open, a reload of the board from disk, a window that loaded again): each one restores the renderer's part. */
  private mounts = 0

  constructor(private readonly hooks: AgentServerHooks) {
    this.bridge = new RendererBridge(hooks.webContents)
    this.records = new SceneStore(
      () => hooks.folder(),
      (stories) => {
        const contents = hooks.webContents()
        if (contents && !contents.isDestroyed()) contents.send(IPC.sceneStories, stories)
      }
    )
    this.news = new BoardNews({
      request: (since) => this.bridge.request('learnerNews', { since }, NEWS_TIMEOUT_MS),
      folderRoot: () => hooks.folderRoot(),
      shownBoard: () => hooks.shownBoard()
    })
    // The board's playback events go to the trace of the session that started the scene, also after that
    // session closed: start returns at once, so a scene can play on after its client is gone.
    ipcMain.on(IPC.sceneEvent, (_event, scene: SceneEvent) => {
      if (scene) this.sceneTraces.get(scene.scene)?.sceneEvent(scene)
    })
  }

  /** A scene that this session started (play_scene start): for its playback events. */
  private ownScene(session: Session, sceneId: string): void {
    const trace = this.traceOf(session)
    if (!trace) return
    this.sceneTraces.set(sceneId, trace)
    if (this.sceneTraces.size > 500) this.sceneTraces.delete(this.sceneTraces.keys().next().value as string)
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  status(): AgentServerStatus {
    const sessions: AgentSessionInfo[] = [...this.sessions.values()].map((session) => ({
      id: session.id,
      clientName: session.server.server.getClientVersion()?.name ?? 'Agent',
      connectedAt: session.connectedAt,
      lastActiveAt: session.lastActivity
    }))
    return { url: this.url, port: this.port, state: this.state, error: this.error, sessions }
  }

  private publish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.lastPublish = Date.now()
    this.hooks.status(this.status())
  }

  /**
   * A session made a request. The UI shows agents by recent activity (short
   * clients like `claude -p` exit without DELETE), so it needs lastActiveAt:
   * publish at most once per PUBLISH_THROTTLE_MS.
   */
  private touch(session: Session): void {
    session.lastActivity = Date.now()
    if (this.publishTimer) return
    const wait = Math.max(0, this.lastPublish + PUBLISH_THROTTLE_MS - Date.now())
    this.publishTimer = setTimeout(() => this.publish(), wait)
  }

  start(): void {
    const server = createServer((req, res) => {
      this.route(req, res).catch((error: unknown) => {
        console.error(`mcp: request failed: ${String(error)}`)
        if (!res.headersSent) this.jsonError(res, 500, -32603, 'Internal server error')
      })
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.state = 'error'
      this.error =
        error.code === 'EADDRINUSE'
          ? `Port ${this.port} is in use (another Learning Space?). Set SPACE_MCP_PORT to use another port.`
          : `The agent server could not start: ${error.message}`
      console.error(`mcp: ${this.error}`)
      this.publish()
    })
    server.listen(this.port, '127.0.0.1', () => {
      this.state = 'listening'
      this.error = null
      console.log(`mcp: listening on ${this.url}`)
      this.publish()
      this.hooks.listening?.()
    })
    this.http = server
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.publishTimer) clearTimeout(this.publishTimer)
    for (const session of [...this.sessions.values()]) await session.transport.close().catch(() => undefined)
    this.http?.close()
    this.http = null
  }

  // ---------- HTTP ----------

  private jsonError(res: ServerResponse, status: number, code: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
  }

  /** Host and Origin checks. Returns a reason when the request must be refused. */
  private refusal(req: IncomingMessage): string | null {
    const host = req.headers.host
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return `Host "${host ?? ''}" is not allowed`
    if (req.headers.origin !== undefined) return `requests from web pages (Origin "${req.headers.origin}") are not allowed`
    return null
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reason = this.refusal(req)
    if (reason) {
      console.warn(`mcp: refused ${req.method} ${req.url}: ${reason}`)
      this.jsonError(res, 403, -32000, `Forbidden: ${reason}`)
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/news') {
      await this.serveNews(req, res)
      return
    }
    if (path !== '/mcp') {
      this.jsonError(res, 404, -32000, 'Not found. The MCP endpoint is /mcp.')
      return
    }

    const header = req.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (sessionId && !session) {
      this.jsonError(res, 404, -32001, 'Session not found. Initialize a new session.')
      return
    }
    if (session) this.touch(session)

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await readJson(req)
      } catch (error) {
        if (error instanceof BodyTooLarge) this.jsonError(res, 413, -32600, error.message)
        else this.jsonError(res, 400, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (session) {
        await session.transport.handleRequest(req, res, body)
        return
      }
      if (!isInitializeRequest(body)) {
        this.jsonError(res, 400, -32000, 'Bad request: no Mcp-Session-Id header, and the message is not "initialize".')
        return
      }
      await this.createSession().transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!session) {
        this.jsonError(res, 400, -32000, 'Bad request: the Mcp-Session-Id header is missing.')
        return
      }
      if (req.method === 'GET') {
        session.openStreams++
        res.on('close', () => {
          session.openStreams--
        })
      }
      await session.transport.handleRequest(req, res)
      return
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
  }

  /** GET /news?client=<label>: deliver the board news line for that agent app, or an empty body. Never an error for a valid GET. */
  private async serveNews(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end()
      return
    }
    // Delivering news marks it as read, so only the local hook (the relay's `news` command) may ask.
    // A web page in a browser always sends Origin or Sec-Fetch-Site; the relay's fetch sends neither.
    // The Host check stops a DNS-rebinding page that resolves its own name to 127.0.0.1.
    const fetchSite = req.headers['sec-fetch-site']
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (req.headers.origin !== undefined || (fetchSite !== undefined && fetchSite !== 'none') || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      res.writeHead(403).end()
      return
    }
    const client = new URL(req.url ?? '/news', 'http://127.0.0.1').searchParams.get('client')?.trim() ?? ''
    let line = ''
    try {
      if (client) line = await this.news.deliver(clientLabel(client))
    } catch (error) {
      console.warn(`mcp: news for "${client}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(line)
  }

  /**
   * The tools/list result and the built-in server instructions, as an agent
   * sees them, for the relay's offline cache (~/.learning-space/tools.json).
   * It runs the real registration in process, so it opens no agent session.
   */
  async catalog(): Promise<{ tools: unknown[]; instructions: string }> {
    const instructions = serverInstructions(null)
    const server = new McpServer({ name: 'learning-space', version: app.getVersion() }, { instructions })
    const session: Session = {
      id: 'catalog',
      server,
      transport: new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      openStreams: 0,
      cursors: new Map()
    }
    this.registerTools(session)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'learning-space-catalog', version: app.getVersion() })
    try {
      await server.connect(serverSide)
      await client.connect(clientSide)
      const { tools } = await client.listTools()
      return { tools, instructions }
    } finally {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  }

  // ---------- Sessions ----------

  private createSession(): Session {
    const server = new McpServer({ name: 'learning-space', version: app.getVersion() }, { instructions: serverInstructions(this.hooks.folderRoot()) })
    const session: Session = {
      id: '',
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          session.id = id
          this.sessions.set(id, session)
          console.log(`mcp: session ${id} opened`)
          // The SDK reads clientInfo after this callback: publish on the next tick, so the name is known.
          setTimeout(() => this.publish(), 0)
        }
      }),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      openStreams: 0,
      cursors: new Map()
    }
    session.transport.onclose = () => {
      if (!session.id || !this.sessions.delete(session.id)) return
      this.cancelPrograms(session.id)
      session.trace?.close()
      console.log(`mcp: session ${session.id} (${server.server.getClientVersion()?.name ?? 'agent'}) closed`)
      this.publish()
    }
    server.server.oninitialized = () => {
      console.log(`mcp: session ${session.id} is ${server.server.getClientVersion()?.name ?? 'an unnamed client'}`)
      this.traceOf(session)
      this.publish()
      // An agent connected: its first screenshot or preview should not wait for the snapshot window.
      this.hooks.snapshots.warm()
    }
    this.registerTools(session)
    void server.connect(session.transport)
    return session
  }

  /** Close sessions whose client went away without a DELETE. */
  private prune(): void {
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      if (session.openStreams <= 0 && now - session.lastActivity > IDLE_SESSION_MS) {
        console.log(`mcp: session ${session.id} idle; closing`)
        void session.transport.close()
      }
    }
  }

  // ---------- Tools ----------

  /** The session's trace, opened on first use. Never throws; null for the in-process catalog session. */
  private traceOf(session: Session): SessionTrace | null {
    if (session.trace) return session.trace
    if (!session.id || session.id === 'catalog') return null
    try {
      const client = session.server.server.getClientVersion()
      session.trace = new SessionTrace({
        sessionId: session.id,
        clientName: client?.name ?? 'agent',
        clientVersion: client?.version ?? null,
        folder: this.hooks.folderRoot(),
        board: this.hooks.shownBoard()
      })
      return session.trace
    } catch (error) {
      console.warn(`trace: could not open a trace for session ${session.id}: ${String(error)}`)
      return null
    }
  }

  /**
   * The renderer saved a board: log the learner's new or changed nodes, if any, to the day's
   * learner-edits.jsonl only (trace-report joins them to sessions by board and time). The
   * renderer computes the delta (it saves about 400 ms after an edit, so `t` is the save
   * time, not the stroke time). Never throws.
   */
  boardSaved(board: string, delta: LearnerEditDelta | null): void {
    try {
      const folder = this.hooks.folderRoot()
      if (folder && delta) writeLearnerEdit({ type: 'learner_edit', t: new Date().toISOString(), folder, board, ...delta })
    } catch (error) {
      console.warn(`trace: learner edit not recorded: ${String(error)}`)
    }
  }

  /** Wrap a tool body: activity pulse, logging, errors as tool errors, the session trace (trace.args: more for the traced args). */
  private tool<A>(session: Session, name: string, body: (args: A, extra: ToolExtra, trace: CallTrace) => Promise<CallToolResult>) {
    return async (args: A, extra?: ToolExtra): Promise<CallToolResult> => {
      session.lastActivity = Date.now()
      this.hooks.activity({ sessionId: session.id, tool: name })
      const start = Date.now()
      // The board news goes out once, before the tool runs (a screenshot then counts as a look after it).
      // get_changes gets none: it lists the same changes itself.
      const news = name === 'get_changes' ? '' : await this.newsLine(session)
      let result: CallToolResult
      let thrown: unknown = null
      const trace: CallTrace = { spans: { news_ms: Date.now() - start } }
      try {
        result = await body(args, extra ?? {}, trace)
      } catch (error) {
        console.warn(`mcp: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
        thrown = error
        result = failure(error)
      }
      if (news) result = { ...result, content: [{ type: 'text', text: news }, ...result.content] }
      this.traceOf(session)?.call(name, trace.args ? { ...(args as Record<string, unknown>), ...trace.args } : args, start, Date.now(), this.hooks.shownBoard(), thrown === null ? result : null, thrown, trace.spans)
      return result
    }
  }

  /** The session's agent app label ("Codex", "Claude Code", …), the key of its news state. */
  private label(session: Session): string {
    return clientLabel(session.server.server.getClientVersion()?.name)
  }

  /** Deliver the board news for this session's agent app: the line, or ''. Never throws. */
  private async newsLine(session: Session): Promise<string> {
    if (!session.id || session.id === 'catalog') return ''
    try {
      return await this.news.deliver(this.label(session))
    } catch {
      return ''
    }
  }

  /**
   * Where a session's change cursor starts on a board: at its agent app's last look there
   * (from an earlier connection), else now. So a new connection's get_changes lists what the
   * learner did since the app last looked.
   */
  private startCursor(session: Session, board: string, now: number): number {
    const root = this.hooks.folderRoot()
    const look = root && session.id && session.id !== 'catalog' ? getAgentLook(this.label(session), root, board) : null
    return look ? Math.min(look.lookSeq, now) : now
  }

  /** Record a look (get_screenshot, get_changes) for this session's agent app. Never throws. */
  private async looked(session: Session, board: string, cursor: number): Promise<void> {
    if (!session.id || session.id === 'catalog') return
    try {
      await this.news.looked(this.label(session), board, cursor)
    } catch (error) {
      console.warn(`mcp: last look not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The first contact with a board starts the session's cursor there. A cursor
   * ahead of the board (the window reloaded and lost unsaved seqs) moves back,
   * so new ink is not hidden behind it.
   */
  private touchCursor(session: Session, info: { board: { path: string } | null; cursor: number | null }): void {
    if (!info.board || info.cursor === null) return
    const path = info.board.path
    const current = session.cursors.get(path)
    if (current === undefined) session.cursors.set(path, this.startCursor(session, path, info.cursor))
    else if (current > info.cursor) {
      console.warn(`mcp: ${path} seq went back from ${current} to ${info.cursor}; resetting the cursor`)
      session.cursors.set(path, info.cursor)
    }
  }

  /** Run a board tool in the renderer, as this session. */
  /** End running scene programs (all, or one session's). Returns how many were running. */
  private cancelPrograms(sessionId: string | null): number {
    let count = 0
    for (const [program, owner] of this.programs) {
      if (sessionId !== null && owner !== sessionId) continue
      if (!program.signal.aborted) count++
      program.abort()
      this.programs.delete(program)
    }
    if (count) console.log(`mcp: cancelled ${count} running scene program(s)`)
    return count
  }

  /**
   * The file side of the one board-change operation (renderer App.tsx changeBoard, through
   * main/index.ts): a renamed board keeps its drafts, every session's change cursor and its
   * stage under the new path; a board that went to the Trash loses them. Nothing else moves here:
   * the app state (camera, last board, agent looks) moves in state.ts, ink groups in the renderer.
   */
  boardMoved(from: string, to: string | null): void {
    const drafts = this.drafts.get(from)
    this.drafts.delete(from)
    if (drafts && to) this.drafts.set(to, drafts)
    for (const session of this.sessions.values()) {
      const cursor = session.cursors.get(from)
      session.cursors.delete(from)
      if (cursor !== undefined && to) session.cursors.set(to, cursor)
    }
    this.stage.boardMoved(from, to)
    // A renamed board keeps its stage: it was restored for this mount.
    const root = this.hooks.folderRoot() ?? ''
    if (to && this.restoredFor === `${root}\0${from}\0${this.mounts}`) this.restoredFor = `${root}\0${to}\0${this.mounts}`
    this.records.boardMoved(from)
    this.boardIndex.moved(from, to)
    console.log(`boards: ${from} ${to ? `renamed to ${to}` : 'went to the Trash'}; drafts, cursors and stage ${to ? 'moved' : 'ended'}`)
  }

  /** The open board from the renderer's memory (unsaved changes included), or null. Never throws. */
  private async openBoardInfo(query: string | null): Promise<OpenBoardInfo | null> {
    try {
      return await this.bridge.request('boardDigest', { query })
    } catch {
      return null
    }
  }

  /** The board window's renderer loaded: it gets its port to the stage for frames (live-scene.ts). */
  linkBoard(contents: WebContents): void {
    this.stage.linkBoard(contents)
  }

  /**
   * Replace or cut a scene: the stage goes back to before it, its items come
   * off the board (with those of the waiting scenes after it), the scene's
   * new program (play_scene start of a scene that is on the board) or its own
   * program cut at a time (cut) runs and takes its place, then every program
   * after it runs again on the new stage. A scene that waits or plays keeps
   * its place in the queue and its clock; the replaced scene, when it has
   * played, plays again (when). A later scene that has played comes back at
   * once in its new final state, without playing, so the board shows what
   * the stage holds. All of it is one undo step. Runs inside stage.exclusive.
   *
   * signal cancels it (play_scene cancel, stop, clear_queue, the client). A
   * cancel, or a new program that fails, puts the earlier scenes back on the
   * stage and on the board (see restore); a cancel then throws SceneCancelled.
   */
  private async restage(
    sceneId: string,
    waiting: string[],
    change: { source?: SceneSource; seed?: number; cutAt?: number; name?: string; when?: 'queue' | 'now' },
    signal: AbortSignal
  ): Promise<CallToolResult | { main: SceneResult & { ends_in_s: number }; rerun: Array<{ scene: string; ok: boolean; error?: string; starts_in_s?: number }> }> {
    const control = (args: Record<string, unknown>): Promise<unknown> => this.board('sceneControl', args)
    const stopped = (): void => {
      if (signal.aborted) throw new SceneCancelled()
    }
    stopped()
    const before = (await control({ action: 'status' })) as { playing_scene?: { id: string } | null; board_id?: string }
    const playingNow = before.playing_scene?.id
    // The board of this restage's record events (scene-store.ts RecordBoard), fixed now.
    const path = this.boardKey()
    const recordBoard = this.records.board(path, before.board_id)
    // Its calls to the board name the board, which refuses them once another board is shown (renderer live/run.ts sameBoard).
    const boardId = before.board_id ?? null
    const mount = this.mounts
    const boardChanged = (): boolean => this.mounts !== mount
    stopped()
    const live = (id: string): boolean => waiting.includes(id) || playingNow === id
    const label = change.name ?? this.sceneName(sceneId)
    // A new program runs at the scene's place, as write_scene ran its draft (placeAt): the same stage and the same board.
    const placed = this.stage.log.find((entry) => entry.scene === sceneId)
    const place = change.source !== undefined && placed ? this.placeAt(placed) : null
    const cut = this.stage.truncateBefore(sceneId)
    if (!cut) return failure(new Error(`The scene "${label}" is not part of the current stage (it ran before the stage started new).`))
    const later = cut.later
    // Every later scene comes off the board too: it is committed again from its new run. A marked one (its program
    // cannot run: live-scene.ts StageEntry.failed) keeps its items and its place, and does not run.
    const affected = [sceneId, ...later.filter((entry) => !entry.failed).map((entry) => entry.scene).filter((id): id is string => !!id)]
    // The reverts and every commit of the restage are one undo step for the learner (Board agentCommit's step key).
    const step = `restage-${sceneId}-${Date.now()}`
    // The record lines of the restage, written when it succeeds (main decides): a rollback writes none.
    const lines: Array<[StageEntry, SceneResult]> = []
    /** Commit a run of the scene id: the board takes it (nodeIds: the node ids and z its new nodes take, in their order). */
    const commit = async (id: string, run: StageRun, name: string | null, extra: Record<string, unknown> = {}): Promise<SceneResult & { ends_in_s: number; kept_ids?: boolean }> => {
      const result = (await this.board('runScene', { scene: run.desc, job: run.job, frames: run.frames, sceneId: id, slot: true, slotWhy: id === sceneId && change.cutAt !== undefined ? 'cut' : 'replaced', step, boardId, ...(name ? { name } : {}), ...extra }, SCENE_TIMEOUT_MS)) as SceneResult & { ends_in_s: number; kept_ids?: boolean }
      run.entry.scene = id
      return result
    }
    /** Run a program: on the context, answers and seed of its earlier run (original), or on the board now. */
    const runOne = async (source: SceneSource, options: { seed?: number; cutAt: number | null; original?: StageEntry; name: string | null; place?: StagePlace | null }): Promise<StageRun> => {
      const context = options.original ? this.stage.savedContext(options.original) : await this.contextAt(options.place ?? null)
      // The same program on the same context gets the board's answers of its first run (html sizes, empty places).
      const run = await this.stage.run(source, context, { mode: 'scene', seed: options.seed, cutAt: options.cutAt, name: options.name, answers: options.original?.answers, signal, place: options.place })
      const liveError = await this.checkLivePrograms(livesOf(run.desc))
      if (liveError || signal.aborted) {
        this.stage.discard(run.entry)
        throw liveError ?? new SceneCancelled()
      }
      return run
    }
    /** What the first revert took off: each scene's node ids, and the items of the replaced scene when it is marked (it cannot run again). */
    let reverted: { created: Record<string, Array<[string, number | null]>>; taken: Record<string, unknown> } = { created: {}, taken: {} }
    /**
     * The earlier state again: the log as it was before this scene, every
     * affected scene's items off the board, then the scene and the ones after
     * it run as they ran before (same context, answers, seed and cut) and go
     * back on the board in the same undo step, each node with the id and z
     * it had, so the record's lines still describe them (no line is written;
     * a scene whose run makes other nodes gets a new line). A marked scene does not
     * run: one the restage did not touch keeps its place, and the replaced
     * one gets its items back as the first revert took them. A scene that
     * waited or played, or that the player holds now, takes its place in the
     * queue again; a scene that has played comes back in its end state. A
     * restore cannot be cancelled: these programs ran to their end before.
     */
    const restore = async (): Promise<void> => {
      this.stage.truncate(cut.index)
      await control({ action: 'revert', scenes: affected, step, boardId })
      const now = (await control({ action: 'status' })) as { waiting?: string[]; playing_scene?: { id: string } | null }
      const held = new Set([...(now.waiting ?? []), ...(now.playing_scene ? [now.playing_scene.id] : [])])
      for (const entry of [cut.entry, ...later]) {
        const id = entry.scene
        if (entry.failed) {
          this.stage.keep(entry)
          if (id && reverted.taken[id]) await control({ action: 'putBack', scene: id, taken: reverted.taken[id], step, boardId })
          continue
        }
        const run = await this.stage.run(entry.source, this.stage.savedContext(entry), { mode: 'scene', seed: entry.seed, cutAt: entry.cutAt, name: entry.name, answers: entry.answers })
        if (!id) continue
        const result = await commit(id, run, entry.name, { nodeIds: reverted.created[id] ?? [], ...(live(id) || held.has(id) ? {} : { settled: true }) })
        if (!result.kept_ids) await this.recordCommit(run.entry, result)
      }
    }
    let main: SceneResult & { ends_in_s: number }
    const rerun: Array<{ scene: string; ok: boolean; error?: string; starts_in_s?: number }> = []
    // Drop lines wait for the end too: a rollback brings those scenes back.
    const dropped: string[] = []
    /** The restage's record events, for the board they were made on. */
    const record = async (): Promise<void> => {
      for (const [entry, result] of lines) await this.recordCommit(entry, result)
      await this.records.drop(recordBoard, dropped)
    }
    try {
      reverted = (await control({ action: 'revert', scenes: affected, step, boardId, keep: cut.entry.failed ? [sceneId] : [] })) as unknown as typeof reverted
      stopped()
      const run =
        change.source !== undefined
          ? await runOne(change.source, { seed: change.seed, cutAt: null, name: change.name ?? cut.entry.name, place })
          : // A cut runs the same program with the same seed and context, so it is the same up to the cut.
            await runOne(cut.entry.source, { seed: cut.entry.seed, cutAt: change.cutAt ?? null, original: cut.entry, name: cut.entry.name })
      main = await commit(sceneId, run, run.entry.name, change.when ? { when: change.when } : {})
      lines.push([run.entry, main])
      for (const entry of later) {
        if (entry.failed) {
          this.stage.keep(entry)
          continue
        }
        const id = entry.scene
        const queued = !!id && waiting.includes(id)
        try {
          // A waiting scene runs on the board as it is now; a scene that has played keeps its earlier context. Each keeps its cut.
          const run = await runOne(entry.source, { seed: entry.seed, cutAt: entry.cutAt, name: entry.name, ...(queued ? {} : { original: entry }) })
          run.entry.scene = id
          if (queued && id) {
            const result = await commit(id, run, entry.name)
            lines.push([run.entry, result])
            rerun.push({ scene: entry.name ?? id, ok: true, starts_in_s: result.starts_in_s })
          } else if (id) {
            lines.push([run.entry, await commit(id, run, entry.name, { settled: true })])
            rerun.push({ scene: entry.name ?? id, ok: true })
          }
        } catch (error) {
          if (error instanceof SceneCancelled || signal.aborted || boardChanged()) throw error
          if (queued && id) await control({ action: 'drop', scene: id })
          // It left the stage (and the board) without a new version.
          if (id) dropped.push(id)
          rerun.push({ scene: entry.name ?? id ?? '?', ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      if (boardChanged()) {
        // Another board is shown now: it is not touched. The board of the restage keeps what it got (it was saved as it was), and so does its record.
        await record()
        return failure(new Error(`The board changed while the scene "${label}" ran again, so the restage stopped there.`))
      }
      // The scenes stay as they were (a scene that has played is not played again).
      await restore()
      if (error instanceof SceneCancelled || signal.aborted) throw new SceneCancelled()
      const failed = error instanceof Error ? error.message : String(error)
      return failure(
        new Error(
          change.source !== undefined
            ? `play_scene start failed, and the scene "${label}" on the board stays as it was: ${failed}\nThe draft is kept. Change it with write_scene.`
            : `cut failed, and the scene "${label}" stays as it was: ${failed}`
        )
      )
    }
    await record()
    return { main, rerun }
  }

  /**
   * Compile every shader()/canvas() program of a scene with the board's own
   * compiler before anything plays. A failing one is a program error at the
   * line of its shader()/canvas() call; the compile log keeps the line
   * numbers of the agent's shader or canvas code.
   */
  private async checkLivePrograms(lives: LiveCheck[]): Promise<SceneProgramError | null> {
    type Live = LiveCheck
    const failed: Array<{ live: Live; error: string }> = []
    // The same code is checked once; at most LIVE_CHECKS checks run at once.
    const checks = new Map<string, { args: AgentMethods['validateLive']['params']; lives: Live[] }>()
    for (const live of lives) {
      const args = { mode: live.mode, code: live.code, params: live.params, size: [live.width, live.height] as [number, number] }
      const key = JSON.stringify(args)
      const check = checks.get(key)
      if (check) check.lives.push(live)
      else checks.set(key, { args, lives: [live] })
    }
    const queue = [...checks.values()]
    const worker = async (): Promise<void> => {
      for (let check = queue.shift(); check; check = queue.shift()) {
        const { error } = await this.bridge.request('validateLive', check.args)
        if (error) for (const live of check.lives) failed.push({ live, error })
      }
    }
    await Promise.all(Array.from({ length: Math.min(LIVE_CHECKS, queue.length) }, worker))
    if (!failed.length) return null
    failed.sort((a, b) => (a.live.file ?? '').localeCompare(b.live.file ?? '') || (a.live.line ?? 0) - (b.live.line ?? 0))
    const what = (entry: { live: Live; error: string }): string => `the ${entry.live.api}() code ${entry.live.mode === 'program' ? 'fails' : 'does not compile'}: ${entry.error}`
    if (failed.length === 1) return new SceneProgramError(what(failed[0]), failed[0].live.line ?? null, failed[0].live.file ?? null)
    return new SceneProgramError(failed.map((entry) => (entry.live.line ? `${siteLabel({ file: entry.live.file ?? null, line: entry.live.line })}: ${what(entry)}` : what(entry))).join('\n'), null)
  }

  private board(tool: AgentToolName, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.bridge.request('agentTool', { tool, args }, timeoutMs)
  }

  /**
   * A draft run that ended in the stage (its frames are in the renderer):
   * the renderer compiles it and keeps it under its key. Then it is ready.
   */
  private async readyDraft(run: StageRun, context: SceneContext, name: string, source: SceneSource, seq: number, place: StagePlace | null): Promise<Draft> {
    const info = (await this.board('sceneDraft', { scene: run.desc, job: run.job, frames: run.frames, draft: draftKey(run.desc), name, ...(place ? { place: place.board } : {}) }, SCENE_TIMEOUT_MS)) as DraftInfo
    return { name, source, desc: run.desc, entry: run.entry, fresh: run.fresh, revision: this.stage.revision, contextKey: contextKey(context), seq, info }
  }

  /**
   * The record line of a commit the board accepted (scene-store.ts), for the board it names. A commit
   * that gave the board its id saves the board file first, so no history is written that the board
   * file does not point to.
   */
  private async recordCommit(entry: StageEntry, result: SceneResult): Promise<void> {
    const record = result.record
    // The board the commit was for, as the renderer had it when it accepted the commit (a folder or board that opened since changes nothing).
    const board = record ? this.records.boardOf(record) : null
    if (!record || !board) return
    if (record.newBoard) {
      const saved = await this.bridge.request('saveBoard', {}).then(
        (answer) => answer.saved,
        () => false
      )
      if (!saved) {
        console.error(`scene records: ${board.path} could not be saved with its new id ${board.id}, so its first scene line is not written (the scene plays)`)
        return
      }
    }
    await this.records.scene(board, entry, record)
  }

  /** The scene ids and names of the current stage, for the renderer's reads. */
  private stageScenes(): Array<{ id: string; name: string | null }> {
    return this.stage.log.filter((entry) => entry.scene).map((entry) => ({ id: entry.scene as string, name: entry.name ?? null }))
  }

  /** The session's change cursor on the open board after its first contact there, or null when no board is open. */
  private async lookCursor(session: Session): Promise<number | null> {
    const info = await this.bridge.request('cursorInfo', {})
    this.touchCursor(session, info)
    return info.board ? (session.cursors.get(info.board.path) ?? null) : null
  }

  private registerTools(session: Session): void {
    const server = session.server

    server.registerTool(
      'list_items',
      {
        title: 'Items on the board',
        description: `Lists the items on the open board, one line per item with kind, name, id and bounds ("x,y w×h"), grouped as the learner's work (their ink groups and items), your scenes (the items each scene made), material (frames${htmlMaterial(' and HTML material')}, by title) and other items. Text shows its first words; ink shows as ink groups with author and stroke count. With part "view" or "board" the list starts with the current state: the learning folder, the open board and how many other boards the folder has, the learner's view, the learner's selection and current tool, a scene that plays, and your last look. Narrower parts and a search start with one line: the board, its revision, and what changed since your last look.

Use it when you start work on a board, and whenever you need ids, sizes or free areas, or want to see how material is grouped. It returns no image: to see what is written or drawn, use get_screenshot. For the other boards of the folder, use list_boards.

- part chooses what to list: "view" (what the learner sees now; the default), "board" (the whole board), {region: {x, y, width, height}}, {id: "g3"} or {id: [...]} (items, ink groups or frames, with what they hold), {scene: "name"} (the items a scene made or changed), or {scene: "name", step: 2} or "name#2" (the items of one step: by number, or by name, which finds the first step with that name). The board keeps its scenes, so these work after the app restarts. A plain string works for an id or a name that only one thing has; when several have it, the result lists them.
- With part "view", the items outside the view are summarised by place, each place with its region.
- With part "view" or "board", when there are many items, the list summarises them by area, with counts and a region for each. Each area opens with one more call; nothing is left out.
- query searches the text on the open board: text, ${htmlMaterial('HTML material, ')}names, and the names and lines of the board's scenes. Handwriting is not text: read it with get_screenshot.
- The last line names the calls that show more.
- Coordinates are board points: origin at the centre, +x right, +y down.
- How the app groups strokes into ink groups, and how their ids behave, is in get_guide topic "model".`,
        inputSchema: strictInput('list_items', {
          part: z
            .union(partForms)
            .optional()
            .describe('What to list: "view" (default), "board", {region}, {id}, {scene}, {scene, step} or "name#2", or an id or name that only one thing has.'),
          query: z.string().min(1).optional().describe('Text to search for on the open board. Returns each match with the words around it, its id and its place.'),
          depth: z.number().int().min(1).max(10).optional().describe('How many levels inside frames to list, 1 to 10. Default 3.')
        }),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      this.tool(session, 'list_items', async ({ part, query, depth }) => {
        const look = await this.lookCursor(session)
        const out = await this.bridge.request('boardRead', { part, query, depth, look, scenes: this.stageScenes() })
        return text(out.text)
      })
    )

    server.registerTool(
      'get_screenshot',
      {
        title: 'Screenshot of the board',
        description: `Renders part of the open board to a PNG image, the way the learner sees it (ink, text, maths, drawings, images; no app interface), with a text that maps image pixels to board points.

Use it to read handwriting and to see how a drawing looks. For ids, sizes and structure, list_items is much smaller.

- What to capture, with part: "view" (what the learner sees now; the default), "board" (the whole board), "selection" (what the learner selected), {region: {x, y, width, height}} (an exact board rect), {id: "g3"} or {id: [...]} (items or ink groups, with a small margin), {scene: "name"} (the items a scene made), {scene: "name", step: 2} (the items of one step, by number or name), or {changes: "c115-c1115"} (an interval from get_changes).
- part {changes: …} shows the items of that interval: items added, moved, resized or edited in dashed blue boxes, removed items in dashed pink boxes.
- Any area works, also outside the learner's view.
- labels: true adds id tags and outlines; grid: true adds board coordinates every 100 points. Both appear only in your image.
- While a scene plays, the image shows the board at that moment, not the scene's end state, and the text says so.
- Large areas make large images. An id or a small region gives the sharpest view of handwriting.`,
        inputSchema: strictInput('get_screenshot', {
          part: z
            .union([...partForms, z.object({ changes: z.string().min(1) }).strict()])
            .optional()
            .describe('What to capture: "view" (default), "board", "selection", {region}, {id}, {scene} or {scene, step}, {changes}, or an id or name that only one thing has.'),
          scale: z.number().positive().max(4).optional().describe('Image pixels per board point (default 1). Lowered when the image would exceed max_size.'),
          max_size: z.number().int().min(256).max(4096).optional().describe('The longest image side in pixels. Default: 1024 for "view" and "board" and for any area longer than 1000 board points; 1600 for smaller crops.'),
          labels: z.boolean().optional().describe('Draw id tags and outlines on the image (default false).'),
          grid: z.boolean().optional().describe('Draw a board-coordinate grid on the image (default false).')
        }),
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_screenshot', async ({ part, scale, max_size, labels, grid }, _extra, trace) => {
        const plan = await this.bridge.request('screenshotPlan', {
          part,
          scale: scale ?? 1,
          maxSize: max_size ?? null,
          labels: labels ?? false,
          grid: grid ?? false,
          scenes: this.stageScenes()
        })
        if (!session.cursors.has(plan.board)) session.cursors.set(plan.board, this.startCursor(session, plan.board, plan.cursor))
        await this.looked(session, plan.board, plan.cursor)
        if (plan.kind === 'empty') return text(plan.message)
        const shot = await this.hooks.snapshots.capture({
          nodes: plan.nodes,
          rect: plan.rect,
          scale: plan.scale,
          width: plan.width,
          height: plan.height,
          outlines: plan.outlines,
          overlays: plan.overlays,
          background: plan.background,
          ...(plan.playback ? { playback: plan.playback } : {})
        })
        Object.assign(trace.spans, { capture_ms: shot.ms, window_ms: shot.windowMs })
        const what = plan.what
        const playing = plan.playing
        const lines = [
          `Board "${plan.board}", ${what}.`,
          ...(playing
            ? [
                `A live scene ${playing.paused ? 'is paused' : 'is playing'} (${playing.name ? `"${playing.name}"` : playing.scene}, ${playing.t ?? 0} s of ${playing.duration ?? 0} s${playing.step ? `, step "${playing.step}"` : ''}): the image shows the board as the learner sees it at this moment, not the scene's end state.`
              ]
            : []),
          `The image (${shot.width}×${shot.height} px) covers the board rect ${json(plan.rect)} at ${plan.scale} px per board point.`,
          'Image pixel (px, py) is board point (x + px / scale, y + py / scale).'
        ]
        if (plan.overlays.labels.length) {
          lines.push(`Id tags (yellow = learner ink group, green = your ink group, blue = item): ${plan.overlays.labels.map((label) => label.text).join(', ')}.`)
        }
        if (plan.overlays.grid) lines.push(`Grid lines every ${plan.overlays.grid} board points, numbered on the top and left edges.`)
        if (shot.missingImages) lines.push(`${shot.missingImages} image(s) did not load and show as empty.`)
        if (plan.changes) {
          lines.push(
            `The interval ${plan.changes.handle}. Dashed blue boxes: ${plan.changes.changed} new or changed item(s). Dashed pink boxes: erased items (${plan.changes.removed} in all; the image is cropped to the new material, so get_changes lists erased items outside it).`
          )
        }
        console.log(`mcp: screenshot ${what} ${shot.width}x${shot.height} in ${shot.ms} ms`)
        return {
          content: [
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: lines.join('\n') }
          ]
        }
      })
    )

    server.registerTool(
      'get_changes',
      {
        title: 'Changes since the last look',
        description: `Tells what is different on the open board since your last look, in short sentences, the learner's changes and yours apart: the ink groups with strokes added or erased (with their place and stroke count), the other items added, removed, moved, resized or edited (by kind and name), and the items your scenes made, by scene. It ends with the interval it covers, such as "c115-c1115", and moves your last look there. Results show a look or a revision as c and a number, such as c336.

Use it to learn what the learner did since you last looked. It returns no image; to see the items, use get_screenshot with part {changes: "c115-c1115"} or an id.

- changes: an interval from an earlier result. The result covers that interval again, also when more has changed since.
- detail: "items" lists each item of the interval as JSON (id, kind, tool, colour, name, by, change, offset, bounds, seq). An item that changed again after the interval shows its current state and says so.
- Your last look starts where your app last looked at this board in an earlier connection; otherwise at your first look in this one (list_items, get_changes, get_screenshot or open_board), so the first call then lists nothing new.
- since: 0 covers everything on the board now, and the items whose removal the app still knows.
- The list includes your own writes; by tells them apart from the learner's.
- change says what happened to the item since your last look: added, restored (it was on the board before, was removed, and is back with the same id, by undo, redo or paste), moved (offset: dx, dy in board points), resized, edited (its content), changed (anything else, or not known), or unchanged (changed and changed back).
- Board news: when the learner drew, erased, added, restored, moved, resized, edited or deleted something since your app's last look or last board news, the next result of any tool starts with a "Board news" line that names each change: strokes by ink group and place, other items by kind and name, with the offset of a move and the new bounds. Each change is in the news once, kept per agent app and board across connections.`,
        inputSchema: strictInput('get_changes', {
          since: z.union([z.number().int().min(0), z.string().regex(/^c\d+$/, 'since is a look such as "c336" or the number 336.')]).optional().describe('A look to compare against instead of your last look, such as "c336" or 336; 0 covers everything on the board now.'),
          changes: z.string().min(1).optional().describe('An interval from an earlier result, such as "c115-c1115".'),
          detail: z.enum(['items']).optional().describe('"items" lists each item of the interval as JSON.')
        }),
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_changes', async ({ since: sinceArg, changes, detail }) => {
        // Results show looks as "c336"; since takes that form or the number.
        const since = typeof sinceArg === 'string' ? Number(sinceArg.slice(1)) : sinceArg
        const scenes = this.stageScenes()
        if (changes !== undefined) {
          const { from, to } = parseInterval(changes)
          return text((await this.bridge.request('changeReport', { from, to, detail, all: false, again: true, scenes })).text)
        }
        // since: 0 means "everything": -1 also catches items from files that carry no seq (seq 0).
        const from = since === undefined ? await this.lookCursor(session) : since === 0 ? -1 : since
        const out = await this.bridge.request('changeReport', { from: from ?? -1, to: null, detail, all: since === 0, again: since !== undefined, scenes })
        session.cursors.set(out.board, out.cursor)
        await this.looked(session, out.board, out.cursor)
        return text(out.text)
      })
    )

    server.registerTool(
      'list_boards',
      {
        title: 'List boards',
        description: `Lists the boards of the learning folder, or searches their text. A board file is JSON that file tools read badly; this tool reads it for you.

Use it when you need to know which boards exist or which board holds something, for example when the learner asks for "the board about synapses". To see the items on the open board, use list_items.

- Without query, it returns every board, one line each: path, last change, counts (the learner's ink strokes, your items and scenes, other items) and the first words of its title. The open board is marked, also when it has unsaved changes.
- With query, it searches every board: board and item names, text, HTML, SVG text, image files and code. It returns one block per board, each match with the words around it, its id and its place. The open board is searched with its unsaved changes.
- When many boards match, the result gives one line per board, with the call that shows its matches.
- Handwriting is not text: read it with get_screenshot on the open board.`,
        inputSchema: strictInput('list_boards', {
          query: z.string().min(1).optional().describe("The words to search for. Without it, the result lists every board."),
          board: z.string().min(1).optional().describe("With query: search only this board, by its path.")
        }),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      this.tool(session, 'list_boards', async ({ query, board }: { query?: string; board?: string }) => {
        const folder = this.hooks.folder()
        if (!folder) return failure(new Error('No learning folder is open in Learning Space. Ask the learner to open one.'))
        if (board !== undefined && query === undefined) return failure(new Error('board limits a search, so it needs query too: list_boards({query: "…", board: ' + JSON.stringify(board) + '}).'))
        const start = performance.now()
        const [{ files, read, readMs }, open] = await Promise.all([this.boardIndex.files(folder), this.openBoardInfo(query ?? null)])
        if (board !== undefined && !files.some((file) => file.path === board)) return failure(new Error(`${JSON.stringify(board)} is not the path of a board in this folder. list_boards() lists the paths.`))
        const out = query === undefined ? boardsListText(folder.name, files, open, Date.now()) : boardsFindText(query, files, open, board ?? null)
        console.log(`list_boards: ${query === undefined ? 'list' : 'search'} over ${files.length} boards in ${(performance.now() - start).toFixed(1)} ms (${read} read from file in ${readMs.toFixed(1)} ms)`)
        return text(out)
      })
    )

    server.registerTool(
      'open_board',
      {
        title: 'Open a board',
        description: `Opens another board of the learning folder in the app, so that the learner and you both see it; the learner's view switches to it. Returns the items of the opened board, as list_items does. With create, it makes a new empty board and opens it.

Use it when the learner asks for another board, or when the work belongs on a board that already exists or on a new one. list_boards lists the boards. It changes what the learner sees: to find which board holds something, use list_boards with query, which opens nothing.

- board is a path or a name that only one board has. When several boards have the name, the result lists them and opens none.
- With create: true, board is the name of the new board, or its path when it goes in a folder other than "boards". There must be no board at that path yet.
- Objects and values of earlier scene programs do not carry over to another board.
- Before it opens another board, the app saves the open one.`,
        inputSchema: strictInput('open_board', {
          board: z.string().min(1).describe("A path relative to the learning folder, ending in .board.json, for example \"boards/Fractions.board.json\", or a name that only one board has. With create: the name or path of the new board."),
          create: z.boolean().optional().describe("Make a new empty board and open it (default false).")
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
      },
      this.tool(session, 'open_board', async ({ board, create }: { board: string; create?: boolean }) => {
        const folder = this.hooks.folder()
        if (!folder) return failure(new Error('No learning folder is open in Learning Space. Ask the learner to open one.'))
        const before = this.hooks.shownBoard()
        let path: string
        let made = false
        if (create) {
          // "Waves", "notes/Waves" or "notes/Waves.board.json": a name, in "boards" or in the folder given.
          const ref = board.trim().replace(/\.board\.json$/i, '')
          const cut = ref.lastIndexOf('/')
          const name = cut < 0 ? ref : ref.slice(cut + 1)
          const dir = cut < 0 ? undefined : ref.slice(0, cut)
          if (!name) return failure(new Error(`${JSON.stringify(board)} has no board name. Give a name, such as "Waves", or a path, such as "notes/Waves".`))
          path = (await this.bridge.request('boardChange', { op: 'create', name, ...(dir ? { folder: dir } : {}) })).path
          made = true
        } else {
          const { files } = await this.boardIndex.files(folder)
          const target = resolveBoard(files, board, false)
          if ('error' in target) return failure(new Error(target.error))
          path = target.path
        }
        const out = await this.bridge.request('openBoard', { path, look: null, scenes: this.stageScenes() })
        this.touchCursor(session, { board: { path: out.board }, cursor: out.cursor })
        const head = made ? `Created ${path}, a new empty board, and opened it for the learner.\n` : ''
        const note = before && before !== out.board ? `\nThe stage now holds this board's scenes: objects and values of the other board's scene programs are gone.` : ''
        return text(head + out.text + note)
      })
    )

    server.registerTool(
      'move_board',
      {
        title: 'Rename or trash a board',
        description: `Renames a board of the learning folder, or moves it to the system Trash. Both move its file: nothing is deleted, and the learner can put a trashed board back from the Trash.

Use it when the learner asks to rename or remove a board. It takes an exact path, from list_boards or list_items, never a name.

- to is the new name, or "trash".
- Your drafts, your last look and the ink group ids go with a renamed board. A renamed open board stays open.
- When the open board goes to the Trash, its drafts and stage end, and the app opens another board; the result names it.
- Before the move, the app saves the open board. When that save fails, nothing moves and the error says why.`,
        inputSchema: strictInput('move_board', {
          path: z.string().min(1).describe("The exact path of the board, relative to the learning folder, for example \"boards/Fractions.board.json\"."),
          to: z.string().min(1).max(120).describe("The new name, without \".board.json\", or \"trash\".")
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
      },
      this.tool(session, 'move_board', async ({ path, to }: { path: string; to: string }) => {
        const folder = this.hooks.folder()
        if (!folder) return failure(new Error('No learning folder is open in Learning Space. Ask the learner to open one.'))
        const { files } = await this.boardIndex.files(folder)
        const target = resolveBoard(files, path, true)
        if ('error' in target) return failure(new Error(target.error))
        if (to.trim() !== 'trash') {
          const done = await this.bridge.request('boardChange', { op: 'rename', path: target.path, name: to.trim().replace(/\.board\.json$/i, '') })
          if (done.path === target.path) return text(`${target.path} already has that name; nothing changed.`)
          return text(`Renamed ${target.path} to ${done.path}.${done.wasOpen ? ' It is the open board and stays open; your drafts, your last look and the ink group ids go with it.' : ''}`)
        }
        const done = await this.bridge.request('boardChange', { op: 'trash', path: target.path })
        let shown: string | null = null
        if (done.wasOpen) {
          // The app opens another board (App.tsx: the first board of the sidebar); wait a moment for it.
          const deadline = Date.now() + 2000
          while (Date.now() < deadline && !((shown = this.hooks.shownBoard()) && shown !== target.path)) await new Promise((resolve) => setTimeout(resolve, 50))
          if (shown === target.path) shown = null
        }
        return text(
          `Moved ${done.path} to the system Trash; the learner can put it back from there.${done.wasOpen ? ` It was the open board: its drafts and stage ended, and the app now shows ${shown ?? 'no board'}.` : ''}`
        )
      })
    )

    server.registerTool(
      'get_brief',
      {
        title: 'The Learning Space brief',
        description:
          "Returns the Learning Space brief as markdown (about 12,000 characters): what the space is for and your part in it, how to find out what the person wants, how to read their work, how to explain by drawing one step at a time, what can go on the board, talking, checking facts, and the learning folder as memory.\n\nUse it at the start of a session when the brief is not in your context. In a learning folder it already is: the folder's AGENTS.md holds the same text. Agents started outside a learning folder, such as Claude Desktop, need this call.\n\n- It holds no technical details of the board; get_guide has those.\n- No parameters.",
        inputSchema: strictInput('get_brief', {}),
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_brief', async () => text(briefText()))
    )

    server.registerTool(
      'get_guide',
      {
        title: 'The board reference',
        description: `Returns one topic of the board reference as markdown: the technical details of the board and of scenes (write_scene, preview_scene, play_scene), the one way to write on it.\n\nUse it before a scene that uses something whose details are not in your context yet: topic "scene" before your first write_scene${htmlMaterial(', topic "html" before your first html() material')}.\n\nTopics:\n${guideTopics(this.hooks.folderRoot())}\n\n- Topics are about 400 to 16,000 characters; "scene" is the longest${codeItems(', and "scene-interact" holds about 12,000 characters of source')}.\n- Without topic, it returns all topics in one text (about 32,000 characters).\n- An unknown topic returns an error that lists the topic names.\n- It does not hold the brief (what the space is for and how you work with the person); get_brief has it.`,
        inputSchema: strictInput('get_guide', {
          topic: z.string().optional().describe(`A topic name from the list in the description, such as "scene" or ${htmlMaterial('"html"', '"ink"')}. Without it, all topics.`)
        }),
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_guide', async ({ topic }) => text(guideText(this.hooks.folderRoot(), topic)))
    )

    server.registerTool(
      'get_item',
      {
        title: 'Items in detail',
        description:
          'Returns the stored details of one or more items or ink groups. By default it is JSON: kind, name, author, parent, children ids, bounds on the board and inside the parent, z order, style, text with markup, SVG element ids, image source, or for ink the tool, colour, width and point count. For an ink group it gives the author, the stroke count, the bounds, the tool and colour, and how large its list of strokes and its points are; as "strokes" and as "points" return them.\n\nUse it when you need exact values before you change an item. For an overview of many items, list_items is smaller.\n\n- id is one id or a list. An item\'s name works as an id: it finds the latest item with that name, as board.node does in a scene. When no item has it, a scene name or a step such as "synapse#2" (step 2 of the scene "synapse") stands for the items of that scene or step. Each id gets its own entry, and an id that is not on the board gets its own error.\n- as chooses what comes back for each item:\n  - "info" (default): the details above.\n' +
          htmlMaterial(
            '  - "html": the item and everything inside it as the HTML subset that a scene\'s html() takes, with inline styles. Use it to restructure existing material: change the HTML, then put it back in a scene with html(markup, {into: board.node(id), mode: "replace"}). Ink is not HTML: it appears as a comment, and a replace leaves it out.\n'
          ) +
          '  - "svg": the SVG markup of a drawing.\n  - "strokes": the strokes of an ink group, each with its id and bounds.\n  - "points": the points of each stroke, as [x, y, pressure] from the stroke\'s origin.' +
          codeItems('\n  - "source": the program of a code item.'),
        inputSchema: strictInput('get_item', {
          id: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('An item id, an ink group id such as "g3", an item name, a scene name or a step such as "synapse#2", or a list of them.'),
          as: z
            .enum(ITEM_FORMS)
            .optional()
            .describe(`What to return for each item: "info" (default), ${htmlMaterial('"html", ')}"svg", "strokes", "points" or "source".`),
          ...(NO_HTML
            ? {}
            : {
                include_ids: z.boolean().optional().describe('With as "html": add data-id attributes for reference (default true). html() does not reuse them; new material gets new ids.')
              })
        }),
        annotations: { readOnlyHint: true }
      },
      // include_ids is in the schema only with HTML material, so its type here is unknown; the schema checked it is a boolean.
      this.tool(session, 'get_item', async (args: { id: string | string[]; as?: string; include_ids?: unknown }) => {
        // Lab switch LS_LAB_NO_HTML (lab-switch.ts): no HTML material, so no "html" form.
        if (NO_HTML && args.as === 'html') return failure(new Error('as "html" is not available.'))
        return text(await this.bridge.request('itemRead', { id: args.id, as: args.as, include_ids: args.include_ids as boolean | undefined, scenes: this.stageScenes() }))
      })
    )

    const momentSchema = z.union([
      z.literal('end'),
      z.object({ step: z.union([z.number().int().min(1), z.string().min(1)]) }).strict(),
      z.object({ time_s: z.number().min(0) }).strict()
    ])

    server.registerTool(
      'write_scene',
      {
        title: 'Write a scene (draft)',
        description:
          "Runs a JavaScript program that draws and writes on the open board over time, and keeps it as a draft under its name. The learner sees nothing of a draft until play_scene \"start\" plays it in front of them. It is the one way to put anything on the board or to change what is there.\n\nA program can draw shapes and ink stroke by stroke, write by hand, set typeset maths and text, fill, fade, move and erase; place " +
          htmlMaterial("HTML material (html(): pages, cards, frames with layout, exercises, inline SVG), ") +
          "pictures (image(): a URL or a file in the learning folder), copies (copy()) and empty space for new material (space()); change text and style (edit()); move items into frames and delete items and ink groups, the learner's too; " +
          codeItems("run live pixels (shaders, canvas programs, and program() items with your own JavaScript and any library, such as three.js, WebGL 2 or WebGPU); ") +
          "move the camera and a pointer; and show lines of text for the learner to read (say). The complete reference is get_guide topic \"scene\".\n\nUse it for everything you draw, write, place, change or remove on the board. To check how a scene looks before the learner sees it, use preview_scene; to look at the board itself, use get_screenshot, list_items and get_changes.\n\nFile or code:\n- Prefer a file. Write the program to boards/scenes/ of the learning folder with your own file tool, and pass its path as file. To change the scene, edit the file and call write_scene again: you send only the change, not the whole program.\n- Use code only for a few lines that you will not change (one mark, one label), or when you have no file tools.\n- Put what more than one scene uses (a pendulum, a neuron, labelled axes) in boards/scenes/lib/ and import it. get_guide topic \"scene-files\" has the rules for files and imports.\n\nHow it runs:\n- The program runs in a sandbox with no access to the app or the network. It reads the scene files that it imports, once, when you call write_scene; a later edit of a file changes nothing until you call write_scene again. It may compute for as long as it needs; play_scene \"cancel\" stops it.\n- Every program on a board runs on the same stage, one after another. What a program puts on the global `stage` object stays for later programs, and objects of earlier programs can be acted on again. A draft reads the stage as it is when you write it, and joins the stage when it starts. A new version of a scene on the board reads the stage as it was just before the old version played. The stage starts new on play_scene \"reset\". When the board changes or the app starts, the app runs the board's scenes again from its records, so their objects and stage values are there as before.\n- A name holds one draft, so writing the same name again replaces it. To change a scene that is already on the board, change its file (or its code), write it again under its name and start it: the new version takes the place of the old one.\n- Drafts live in the app's memory and are lost when the app quits.\n- Coordinates are board points: origin at the centre, +x right, +y down.\n\nReturns JSON: draft (the name), replaces (when a scene of this name is on the board), changed (when an earlier draft of this name was replaced), length_s, steps ([{number, name, start_s, length_s, pause?}]), items ({total, by_kind, named, removed_by_end}), say_lines (how many), log (console.log output), and stage (only when this program started a new stage: why).\n\nErrors: a program error returns its message, its file (for a scene file) and its line number. The stage stays as it was before the program, and the result says whether an earlier draft of this name is kept.",
        inputSchema: strictInput('write_scene', {
          name: z.string().min(1).max(MAX_NAME_CHARS).describe('The scene\'s name, such as "synapse". preview_scene and play_scene find the scene by it, and it also shows in the board news, the learner\'s script panel, logs and traces. Writing the same name again replaces this scene.'),
          code: z
            .string()
            .min(1)
            .optional()
            .describe('The program, inline: the body of an async function, so top-level await works. Use it only for a few lines that you will not change, or when you have no file tools; otherwise use file. It can import scene files. Give code or file, not both. Example: const c = circle(0, 0, 80); await draw(c); await label(c, "r")'),
          file: z.string().min(1).optional().describe('The path of a scene file in boards/scenes/ of the learning folder, such as "pendulum/swing.js". Write the file with your own file tool first. To change the scene, edit the file and pass the same path again. The file uses JavaScript module syntax and can import other scene files. Give code or file, not both.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
      },
      this.tool(session, 'write_scene', async ({ name, code, file }, extra, trace) => {
        if ((code === undefined) === (file === undefined)) return failure(new Error('write_scene takes code or file: one of them, not both.'))
        const board = this.boardKey()
        const before = this.draftsOf(board).get(name)
        const seq = ++this.draftSeq
        let replaces = false
        // The snapshot: the inline code or the file, and every file it imports, read now and never again for this draft.
        let source: SceneSource
        const spans = trace.spans
        const tSnapshot = Date.now()
        try {
          source = await readSceneSource(this.hooks.folder(), code !== undefined ? { code } : { file })
        } catch (error) {
          if (error instanceof SceneProgramError) return failure(new Error(`${error.message}\n${before ? `The draft "${name}" keeps its earlier version.` : `No draft "${name}" was made.`}`))
          throw error
        }
        // The trace keeps the texts of the files it read, so a replay (scripts/perf/replay.mjs) can write them again.
        const files = source.modules.filter((module) => module.path !== null)
        if (files.length) trace.args = { snapshot: { entry: source.entry, modules: files.map(({ path, text }) => ({ path, text })), ...(source.links ? { links: source.links } : {}) } }
        spans.snapshot_ms = Date.now() - tSnapshot
        // The draft is ready when the call returns: its program ran, its frames are in the renderer, the renderer compiled it.
        const tQueue = Date.now()
        const outcome = await this.withProgram(session, extra, (signal) =>
          this.staged(signal, async (): Promise<CallToolResult | Draft> => {
            spans.queue_ms = Date.now() - tQueue
            // A new version of a scene on the board runs where play_scene start runs it: at that scene's place.
            const place = this.placeOf(name)
            replaces = !!place
            const context = await this.contextAt(place)
            const run = await this.stage.run(source, context, { mode: 'draft', name, signal, place })
            Object.assign(spans, run.timing)
            const tLive = Date.now()
            const liveError = await this.checkLivePrograms(livesOf(run.desc))
            spans.live_check_ms = Date.now() - tLive
            if (signal.aborted) throw new SceneCancelled()
            if (liveError) throw liveError
            const tCompile = Date.now()
            const draft = await this.readyDraft(run, context, name, source, seq, place)
            spans.compile_ms = Date.now() - tCompile
            if (signal.aborted) throw new SceneCancelled()
            // Published inside the stage's ownership; an older version never takes the place of a newer one.
            const drafts = this.draftsOf(board)
            const current = drafts.get(name)
            if (!current || current.seq < draft.seq) drafts.set(name, draft)
            return draft
          })
        ).catch((error: unknown) => {
          if (error instanceof SceneProgramError) return failure(new Error(`${error.message}\n${before ? `The draft "${name}" keeps its earlier version.` : `No draft "${name}" was made.`}`))
          if (error instanceof SceneCancelled) return failure(error)
          throw error
        })
        if ('content' in outcome) return outcome
        const info = outcome.info
        console.log(`mcp: write_scene ${name}: ${outcome.desc.objects.length} objects, ${info.duration_s} s, ${info.steps.length} steps`)
        return text(
          json({
            draft: name,
            ...(replaces ? { replaces: `the scene "${name}" on the board: this draft ran at that scene's place on the stage, and play_scene start replaces it in place` } : {}),
            ...(before ? { changed: 'the earlier version of this draft' } : {}),
            length_s: info.duration_s,
            steps: info.steps,
            items: { ...info.items, named: namedOut(info.items.named, `after play_scene start, list_items({part: {scene: ${JSON.stringify(name)}}}) lists each with its id`) },
            say_lines: info.cues.length,
            ...(info.log.length ? { log: info.log } : {}),
            ...(outcome.fresh ? { stage: `new (${outcome.fresh})` } : {})
          })
        )
      })
    )

    server.registerTool(
      'preview_scene',
      {
        title: 'Preview a scene',
        description:
          "Shows you a scene as one image: a draft from write_scene, or a scene already on the board. Nothing is drawn or committed, and the learner sees nothing.\n\nUse it to check a scene before the learner sees it. You can look at its end, at any step or at any moment, and close up on one part, so that text a line runs through, text over text, or something outside the learner's view is caught before the scene plays. To see the board itself as it is now, with the learner's ink, use get_screenshot.\n\n- at chooses the moments. \"end\" (default) is the end of the scene. {step: 3} or {step: \"step name\"} is the end of that step. {time_s: 12.5} is that many seconds from the scene's start. \"steps\" is the end of every step. A list gives up to 12 moments, for example [{step: 2}, {time_s: 20}, \"end\"].\n- part chooses what the image frames. \"scene\" (default) is everything the scene makes or touches. \"view\" is the learner's current view. {region: {x, y, width, height}} is a region in board points. {items: [...]} is a close-up of one or more items: object names from the program, item ids, or ink group ids.\n- One moment gives a large image (up to 1024 px on its longer side), which shows small text. Several moments give one grid of labelled frames.\n- The scene is drawn over the board as it is now. Each frame outlines the learner's view at that moment, and dims and tags the parts of it that the script panel and the tool palette hide." +
          codeItems(" Code items compute up to each moment.") +
          "\n- version \"board\" shows the scene on the board when a draft of the same name also exists. The default is the draft when there is one, else the scene on the board.\n- A scene on the board shows its items as they were at each moment.\n- When the board or the stage changed since write_scene, the draft runs again with the same seed before the pictures (ran_again says why).\n\nReturns the image and JSON: scene, version (\"draft\" or \"board\"), ran_again, length_s, and frames ([{frame, t_s, label}]).\n\nErrors: an unknown name lists the drafts and the scenes on the board; an unknown step lists the steps; a time after the end gives the scene's length.",
        inputSchema: strictInput('preview_scene', {
          name: z.string().min(1).max(MAX_NAME_CHARS).describe('The scene name: a draft or a scene on the board.'),
          at: z
            .union([z.literal('steps'), momentSchema, z.array(momentSchema).min(1).max(MAX_PREVIEW_FRAMES)])
            .optional()
            .describe('The moments: "end" (default), "steps" (the end of every step), {step: number or name} (the end of that step), {time_s: seconds from the start}, or a list of up to 12 of "end", {step} and {time_s}.'),
          part: z
            .union([z.enum(['scene', 'view']), z.object({ region: rectSchema }).strict(), z.object({ items: z.array(z.string().min(1)).min(1).max(20) }).strict()])
            .optional()
            .describe('What the image frames: "scene" (default), "view" (the learner\'s view), {region: {x, y, width, height}} in board points, or {items: [object names, item ids or ink group ids]} for a close-up.'),
          version: z.enum(['draft', 'board']).optional().describe('"draft" or "board" (the scene as it is on the board). Default: the draft when there is one, else the board.')
        }),
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'preview_scene', async ({ name, at, part, version }, extra, trace) => {
        await this.restoreIfNeeded()
        const board = this.boardKey()
        const draft = this.draftsOf(board).get(name)
        const onBoard = this.boardScene(name)
        const use = version ?? (draft ? 'draft' : onBoard ? 'board' : null)
        if (use === null || (use === 'draft' && !draft) || (use === 'board' && !onBoard)) return failure(this.unknownScene(name, use))
        if (use === 'board') {
          const failed = await this.playable([onBoard!.scene as string])
          if (failed.size) return failure(new Error(`The scene "${name}" could not be rebuilt after the app started again, so it cannot be previewed (${[...failed.values()][0]}). get_screenshot shows the board as it is now.`))
        }
        const moments: FrameMoment[] = (at === undefined ? ['end' as const] : Array.isArray(at) ? at : [at]).map((moment) =>
          moment === 'end' ? { kind: 'end' } : moment === 'steps' ? { kind: 'steps' } : 'step' in moment ? { kind: 'step', step: moment.step } : { kind: 't', t: moment.time_s }
        )
        const framePart: FramePart =
          part === undefined || part === 'scene' ? { kind: 'scene' } : part === 'view' ? { kind: 'view' } : 'region' in part ? { kind: 'region', rect: part.region } : { kind: 'items', items: part.items }
        let rerun: string | null = null
        let plan: FramesResult
        const framesStart = Date.now()
        if (use === 'draft') {
          const args = { label: `the draft "${name}"`, moments, part: framePart }
          let fresh = await this.freshDraft(session, extra, draft!)
          trace.spans.rerun_ms = Date.now() - framesStart
          if ('content' in fresh) return fresh
          rerun = fresh.rerun
          let out = await this.board('sceneFrames', { ...args, draft: draftKey(draft!.desc) }, SCENE_TIMEOUT_MS)
          if (isMissing(out)) {
            // The board no longer holds the draft (its window loaded again, or newer drafts took its place): it runs again.
            fresh = await this.freshDraft(session, extra, draft!, 'the board no longer held the draft')
            if ('content' in fresh) return fresh
            rerun = fresh.rerun
            out = await this.board('sceneFrames', { ...args, draft: draftKey(draft!.desc) }, SCENE_TIMEOUT_MS)
            if (isMissing(out)) throw new Error('The board did not keep the draft. Write it again with write_scene.')
          }
          plan = out as FramesResult
        } else plan = (await this.board('sceneFrames', { sceneId: onBoard!.scene, label: `the scene "${name}" on the board`, moments, part: framePart }, SCENE_TIMEOUT_MS)) as FramesResult
        const single = plan.frames.length === 1
        const options = single ? { cellLongEdge: SINGLE_FRAME_EDGE, maxScale: 4 } : {}
        // Live items first, on the main window (their hosts step through the moments), then the snapshot window puts the pictures together.
        const stillsStart = Date.now()
        const { stills } = plan.live.length ? await this.bridge.request('liveStills', { items: plan.live, scale: storyboardScale(plan.rect, options) }, SCENE_TIMEOUT_MS) : { stills: [] }
        const stillsMs = Date.now() - stillsStart
        const framesMs = stillsStart - framesStart
        const pictureStart = Date.now()
        const image = await renderStoryboard(this.hooks.snapshots, { nodes: plan.nodes, frames: plan.frames, rect: plan.rect, background: plan.background, stills }, options)
        const ticks = stills.length ? `; live stills ${stills.filter((still) => still.url).length}/${stills.length} in ${stillsMs} ms at ticks ${stills.map((still) => still.tick ?? '-').join(',')}` : ''
        Object.assign(trace.spans, { frames_ms: framesMs - ((trace.spans.rerun_ms as number | undefined) ?? 0), stills_ms: stillsMs, picture_ms: Date.now() - pictureStart })
        console.log(`mcp: preview_scene ${name} (${use}): ${plan.frames.length} frame(s), ${image.width}x${image.height}; frames ${framesMs} ms, picture ${Date.now() - pictureStart} ms${ticks}`)
        const summary = {
          scene: name,
          version: use === 'draft' ? 'draft (not on the board)' : 'on the board',
          ...(rerun ? { ran_again: rerun } : {}),
          length_s: plan.duration_s,
          frames: plan.frames.map((frame, i) => ({ frame: i + 1, t_s: frame.t, label: frame.label })),
          image: `${plan.frames.length} frame(s)${single ? '' : ` in ${image.columns} column(s), read left to right`}; each covers the board rect ${JSON.stringify(plan.rect)} at ${Math.round(image.scale * 100) / 100} px per board point. Each frame outlines the learner's view at its moment and dims the parts that the script panel or the tool palette hide.`
        }
        return {
          content: [
            { type: 'image', data: image.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: json(summary) }
          ]
        }
      })
    )

    server.registerTool(
      'play_scene',
      {
        title: 'Play scenes for the learner',
        description:
          "Plays scenes from write_scene for the learner, and controls their playback and the stage they run on. The learner sees everything this tool does.\n\nActions:\n- \"start\" (name, when): puts the draft of that name on the board and plays it. If a scene of that name is already there, the new version takes its place: a waiting scene keeps its place in the queue, a playing scene goes on from the same time, and a scene that has played comes off the board and plays again. Starting uses up the draft, so a later change begins with write_scene again.\n- \"status\" changes nothing.\n- \"pause\" holds the playing scene where it is. \"resume\" continues a paused scene: after a pause step, after the learner's drawing paused it, or after \"pause\".\n- \"next\" jumps the playing scene to the start of its next step and plays on, also from a pause. At the last step it ends the scene.\n- \"stop\" jumps the playing scene to its end state; the next waiting scene starts.\n- \"clear_queue\" drops the scenes that wait in the queue, takes their items off the board and their programs off the stage.\n- \"cancel\" ends scene programs that are still running (write_scene and start calls that have not returned). Their call returns an error that starts with \"Cancelled\", and nothing of them is drawn. A program has no time limit, so this is how one that never ends is stopped. \"stop\" and \"clear_queue\" also end them.\n- \"replay\" (name and/or from_step, when) plays again a scene that has already played, from its start or from the step. Its items show as they were at that moment and play to its end; then the board shows its current state.\n- \"cut\" (after_step) drops the rest of the playing scene after that step, or from now without after_step. What starts later is not drawn, and what runs then holds where it is. With name, it acts only when that scene plays.\n- \"reset\" starts a new, empty stage. Board items stay; objects, values and `stage` from earlier programs are gone.\n\nHow playback works:\n- A scene started while another plays starts when that one ends, after the scenes already waiting, with no gap. when: \"now\" starts it at once, over the others.\n- A step with {pause: true} holds playback until \"resume\" or \"next\". When the learner starts drawing, playback pauses at the next step (or at once when no step is left), and the board news says so.\n- say lines are shown as text at a reading pace; nothing is spoken.\n\nAfter a scene plays, everything stays as ordinary items the learner can edit: ink (one ink group per ink object), svg items (shapes), text items (tex, text), " +
          htmlMaterial("html() material and ") +
          "image() material (its root node with everything inside), " +
          codeItems("live items, ") +
          "and one frame per named group. What the scene erased or faded out is gone. start, cut and clear_queue are each one undo step for the learner, and the board file holds the final state from the moment the call returns.\n\nstart returns JSON: scene, replaced, ran_again (the program ran again because the board or the stage changed since write_scene), length_s, starts_in_s and ends_in_s (seconds from now, pauses not counted), steps, items ({total, by_kind, named: the named items with their ids and steps}; list_items with part {scene: \"name\"} lists every item), log, rerun (later scenes that ran again after a replace), and stage. The other actions return the status after the action: {playing, scene, t, duration_s, step, paused, paused_by (\"pause step\", \"learner drawing\" or \"play_scene pause\"), paused_scene, paused_step, paused_t, queue: [{scene, duration_s}]}, with cancelled_programs, cut or replay where they apply.\n\nErrors: start without a draft of that name says so, and for a scene that has played it names \"replay\". If the draft runs again and now fails, nothing is drawn and the draft is kept.",
        inputSchema: strictInput('play_scene', {
          action: z.enum(PLAY_ACTIONS).describe('What to do; the description explains each action.'),
          name: z.string().min(1).max(MAX_NAME_CHARS).optional().describe('start, replay: the scene name. cut: act only when this scene plays.'),
          when: z.enum(['queue', 'now']).optional().describe('start, replay: "queue" (default) starts after the scenes that play or wait; "now" starts at once, over them.'),
          from_step: z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('replay: the step number or step name to play from. Without name, a step name finds the latest scene with that step.'),
          after_step: z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('cut: keep this step (number or name) of the playing scene, and drop what comes after it.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
      },
      this.tool(session, 'play_scene', async ({ action, name, when, from_step, after_step }, extra, trace) => {
        const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args)) as Record<string, unknown>
        if (action === 'start') return this.startScene(session, extra, name, when ?? 'queue', trace.spans)
        let cancelled = 0
        if (action === 'stop' || action === 'clear_queue' || action === 'cancel') cancelled = this.cancelPrograms(null)
        if (action === 'cancel') return text(json({ ...publicStatus(await control({ action: 'status' })), cancelled_programs: cancelled }))
        if (action === 'replay') {
          if (!name && from_step === undefined) return failure(new Error('replay needs name (a scene on the board), and from_step to start from a step.'))
          if (!name && typeof from_step === 'number') return failure(new Error('replay with a step number needs name; without name, from_step must be a step name.'))
          await this.restoreIfNeeded()
          let sceneId: string | undefined
          if (name) {
            const entry = this.boardScene(name)
            if (!entry) return failure(this.unknownScene(name, 'board'))
            sceneId = entry.scene as string
          }
          // A scene restored from the records after a restart runs again first (without name: every scene, to find the step).
          const failed = await this.playable(sceneId ? [sceneId] : this.stageScenes().map((scene) => scene.id))
          if (sceneId && failed.has(sceneId)) return failure(new Error(`The scene "${name}" could not be rebuilt after the app started again, so it cannot be replayed (${failed.get(sceneId)}). Its items stay on the board.`))
          const out = await control({ action: 'replay', scene: sceneId, step: from_step, when: when ?? 'queue' })
          const replay = out.replay as { scene: string; of: string; from: number; starts_in_s: number }
          return text(json({ ...publicStatus(out), replay: { scene: name ?? this.sceneName(replay.of), from_s: replay.from, starts_in_s: replay.starts_in_s } }))
        }
        if (action === 'cut') return this.cutScene(session, extra, name, after_step)
        return this.stage.exclusive(async () => {
          if (action === 'clear_queue') {
            const before = await control({ action: 'status' })
            const status = await control({ action: 'skip' })
            this.stage.drop((before.waiting as string[]) ?? [])
            await this.records.drop(this.records.board(this.boardKey(), before.board_id as string | undefined), (before.waiting as string[]) ?? [])
            return text(json({ ...publicStatus(status), cancelled_programs: cancelled }))
          }
          if (action === 'reset') {
            this.stage.reset('play_scene reset')
            const status = await control({ action: 'resetStage', epoch: this.stage.epoch })
            await this.records.reset(this.records.board(this.boardKey(), status.board_id as string | undefined))
            return text(json({ ...publicStatus(status), stage: 'new (play_scene reset)' }))
          }
          // status, pause, resume, next, stop
          return text(json({ ...publicStatus(await control({ action })), ...(cancelled ? { cancelled_programs: cancelled } : {}) }))
        })
      })
    )
  }

  // ---------- Scenes: drafts and the scenes on the board ----------

  /** The board the drafts belong to (folder-relative path; '' when none is shown). */
  private boardKey(): string {
    return this.hooks.shownBoard() ?? ''
  }

  private draftsOf(board: string): Map<string, Draft> {
    let drafts = this.drafts.get(board)
    if (!drafts) this.drafts.set(board, (drafts = new Map()))
    return drafts
  }

  /** The scene of the current stage with this name (the latest), or null. */
  private boardScene(name: string): StageEntry | null {
    for (let i = this.stage.log.length - 1; i >= 0; i--) {
      const entry = this.stage.log[i]
      if (entry.scene && entry.name === name) return entry
    }
    return null
  }

  /**
   * Run fn with the stage to itself, on the shown board's stage as its records have it (restoreStage first, again when the
   * board changed meanwhile), and with the renderer holding the stage's failures after fn (publishFailures). signal: the
   * caller's cancel, also while the stage is restored (null: none).
   */
  private staged<T>(signal: AbortSignal | null, fn: () => Promise<T>): Promise<T> {
    return this.stage.exclusive(async () => {
      try {
        await this.restoreStage(signal ?? undefined)
        return await fn()
      } finally {
        await this.publishFailures()
      }
    })
  }

  /** The stage epoch and marked programs that the renderer holds (publishFailures). */
  private shownFailures = ''
  private failuresMark(): string {
    return `${this.stage.epoch}|${this.stage.identities().failed.map(([id]) => id).join(',')}`
  }

  /** The one failure state (StageEntry.failed) of every program of the log, when it changed: the renderer replaces its copy (renderer live/run.ts sceneControl "failures"). */
  private async publishFailures(): Promise<void> {
    const mark = this.failuresMark()
    if (mark === this.shownFailures) return
    try {
      const out = (await this.board('sceneControl', { action: 'failures', epoch: this.stage.epoch, failed: this.stage.identities().failed })) as { applied?: boolean }
      // A renderer still on an earlier epoch takes them with the epoch's restore.
      if (out.applied) this.shownFailures = mark
    } catch (error) {
      console.warn(`stage: the board did not take the stage's failures: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Stage work that no tool call owns (a board that mounted, the board window's replay, a replay's rebuild): play_scene cancel, stop and clear_queue end it, and so does a board that mounts. */
  private background<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const program = new AbortController()
    this.programs.set(program, '')
    return fn(program.signal).finally(() => this.programs.delete(program))
  }

  /** The folder, board and board mount that the stage is restored for (restoreStage). */
  private restoreMark(): string {
    return `${this.hooks.folderRoot() ?? ''}\0${this.boardKey()}\0${this.mounts}`
  }

  /** The stage made to match the records, when it does not yet (a read that needs the stage's scenes runs it first). */
  private async restoreIfNeeded(): Promise<void> {
    if (this.boardKey() && this.restoredFor !== this.restoreMark()) await this.background((signal) => this.staged(signal, async () => undefined))
  }

  /**
   * The shown board's stage as its scene records have it (spec section 5: the stage log and the
   * player's history are caches of the records). One rule: each board mount (an open, a reload of the
   * board from disk, a window that loaded again; also another folder) starts a new stage from the
   * records, whatever the stage held. It runs before every program run (staged). The new stage gets the
   * records' current segment: its scenes that were not dropped, each the version the board shows, in
   * the order of their first line, with the source, seed, cut, context and answers that version ran
   * with, and the stage ids it took (entriesOf). A scene whose code is missing, whose
   * record is of the older key scheme, or whose line is malformed, is marked. The context is built from
   * the log now, so the next program sees the earlier scenes' objects. Then the renderer gets the new
   * epoch, the stage's identities and each scene's record (renderer live/run.ts sceneRestore). Every
   * await can see another folder, board or mount: that work is dropped, and it starts again for the
   * board now. signal cancels it. No time limit: every program of the segment runs again.
   */
  private async restoreStage(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new SceneCancelled()
      const path = this.boardKey()
      if (!path) return
      const mark = this.restoreMark()
      if (this.restoredFor === mark) return
      const stale = (): boolean => this.restoreMark() !== mark
      const started = Date.now()
      const status = (await this.board('sceneControl', { action: 'status' })) as { board_id?: string | null }
      if (stale()) continue
      const board = this.records.board(path, status.board_id ?? undefined)
      const scenes = board ? await this.records.restorable(board) : []
      if (stale()) continue
      const tRead = Date.now()
      // A new stage for this mount: what the stage held (another board, another mount) is dropped.
      this.stage.adopt({ board: path } as SceneContext)
      this.stage.reset(this.restoredFor === null ? 'the app started' : 'the board opened')
      if (scenes.length) this.stage.restore(entriesOf(scenes))
      await this.stage.rebuild(signal)
      if (stale()) continue
      const tRebuilt = Date.now()
      const lines = new Map(scenes.map((scene) => [scene.line.scene, scene]))
      const { keys, failed } = this.stage.identities()
      const answer = (await this.board('sceneRestore', {
        boardId: status.board_id ?? null,
        epoch: this.stage.epoch,
        keys,
        failed,
        scenes: this.stage.log.flatMap((entry) => {
          const scene = entry.scene ? lines.get(entry.scene) : undefined
          if (!scene) return []
          // A malformed line gives the board nothing of it: its items stay as they are, and it cannot be replaced.
          return [scene.problem ? { id: scene.line.scene, name: scene.line.name } : { id: scene.line.scene, name: scene.line.name, story: scene.line.story, revert: scene.line.revert, settle: scene.line.settle ?? null }]
        })
      })) as { stale?: boolean }
      if (answer.stale || stale()) continue
      this.shownFailures = this.failuresMark()
      if (scenes.length) console.log(`stage: restored ${scenes.length} scenes of ${path} from its records${failed.length ? ` (${failed.length} marked: cannot run)` : ''}: read ${tRead - started} ms, rebuild ${tRebuilt - tRead} ms, board ${Date.now() - tRebuilt} ms`)
      this.restoredFor = mark
      return
    }
  }

  /**
   * Play data for scenes restored from the records (restoreStage), for a replay or a preview: the ones
   * the player does not hold run again on the rebuilt stage, each at its place (live-scene.ts
   * resample), and the renderer compiles each run onto the board's own nodes (renderer live/run.ts
   * sceneMemory). Nothing is committed. A scene whose program cannot run, or whose re-run does not
   * match its record, is marked (StageEntry.failed, the one failure state, checked before the player's
   * play data). Returns why each scene of sceneIds that cannot replay could not be rebuilt. Runs inside
   * stage.exclusive.
   */
  private async ensureMemories(sceneIds: string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const entries = this.stage.log.filter((entry) => entry.scene && sceneIds.includes(entry.scene))
    if (!entries.length) return this.failuresOf(sceneIds)
    const state = (await this.board('sceneControl', { action: 'remembered', scenes: entries.map((entry) => entry.scene) })) as { held: string[]; restored: string[] }
    const wanted = new Set(entries.filter((entry) => !entry.failed && !state.held.includes(entry.scene as string) && state.restored.includes(entry.scene as string)))
    if (wanted.size) {
      const started = Date.now()
      const mark = this.restoreMark()
      await this.stage.resample(
        wanted,
        async (entry, run) => {
          if (this.restoreMark() !== mark) throw new SceneCancelled()
          const out = (await this.board('sceneMemory', { scene: run.desc, job: run.job, frames: run.frames, sceneId: entry.scene, place: this.placeAt(entry).board }, SCENE_TIMEOUT_MS)) as { ok?: true; error?: string; stale?: true }
          if (out.error) this.stage.mark(entry, `its re-run does not match its record (${out.error})`)
        },
        signal
      )
      console.log(`stage: rebuilt the play of ${wanted.size} scene(s) for a replay in ${Date.now() - started} ms`)
    }
    return this.failuresOf(sceneIds)
  }

  /** Why each of these scenes cannot run again (StageEntry.failed). */
  private failuresOf(sceneIds: string[]): Map<string, string> {
    return new Map(this.stage.log.filter((entry) => entry.failed && entry.scene && sceneIds.includes(entry.scene)).map((entry) => [entry.scene as string, entry.failed as string]))
  }

  /** A board mounted in the window: the stage work of the board before ends, and its stage is made to match its records soon (restoreStage), so a first scene call does not wait for it. */
  boardMounted(path: string): void {
    this.mounts++
    for (const [program, owner] of this.programs) {
      if (owner !== '') continue
      program.abort()
      this.programs.delete(program)
    }
    setTimeout(() => {
      if (this.boardKey() !== path) return
      void this.background((signal) => this.staged(signal, async () => undefined)).catch((error: unknown) => console.warn(`stage: the stage of ${path} is restored at its first use (${error instanceof Error ? error.message : String(error)})`))
    }, 300)
  }

  /** The board window replays scenes that were restored from the records: their programs run again first. */
  async rebuildScenes(sceneIds: string[]): Promise<void> {
    await this.background((signal) => this.staged(signal, () => this.ensureMemories(sceneIds, signal)))
  }

  /** Make the play data of these scenes, when the player does not hold it (scenes restored from the records), and say why one could not be rebuilt. */
  private async playable(sceneIds: string[]): Promise<Map<string, string>> {
    if (!sceneIds.length) return new Map()
    const ids = sceneIds.filter((id) => !this.failuresOf([id]).size)
    const state = (await this.board('sceneControl', { action: 'remembered', scenes: ids })) as { held: string[]; restored: string[] }
    if (ids.every((id) => state.held.includes(id))) return this.failuresOf(sceneIds)
    return this.background((signal) => this.staged(signal, () => this.ensureMemories(sceneIds, signal)))
  }

  /**
   * Where a new version of the scene `name` runs: at the place of the scene of
   * that name on the stage, or (null) at the end of the stage when no scene
   * has that name. The one rule for write_scene, preview_scene (a draft that
   * runs again) and play_scene start (restage).
   */
  private placeOf(name: string): StagePlace | null {
    const entry = this.boardScene(name)
    return entry ? this.placeAt(entry) : null
  }

  /**
   * The place of a program of the stage's log: the stage before it (stage.run
   * before), and the board without the items of its scene and of the scenes
   * after it (renderer sceneAt), which do not exist there yet.
   */
  private placeAt(entry: StageEntry): StagePlace {
    const index = this.stage.log.indexOf(entry)
    const scenes = this.stage.log
      .slice(index)
      .filter((later) => later.scene)
      .map((later) => ({ id: later.scene as string, name: later.name ?? (later.scene as string) }))
    return { entry, board: { scenes } }
  }

  /** The board as a program at this place sees it (null: the board now). */
  private async contextAt(place: StagePlace | null): Promise<SceneContext> {
    return (await this.board('sceneContext', place ? { place: place.board } : {})) as SceneContext
  }

  /** The name of a committed scene by its id (or the id). */
  private sceneName(id: string): string {
    return this.stage.log.find((entry) => entry.scene === id)?.name ?? id
  }

  /** "No scene named …" with the names that exist. */
  private unknownScene(name: string, want: 'draft' | 'board' | null): Error {
    const drafts = [...this.draftsOf(this.boardKey()).keys()]
    const scenes = [...new Set(this.stage.log.filter((entry) => entry.scene && entry.name).map((entry) => entry.name as string))]
    const list = (names: string[]): string => (names.length ? names.map((entry) => `"${entry}"`).join(', ') : 'none')
    const what = want === 'draft' ? `No draft named "${name}" on this board.` : want === 'board' ? `No scene named "${name}" is on this board's stage.` : `No draft and no scene named "${name}" on this board.`
    return new Error(`${what} Drafts: ${list(drafts)}. Scenes on the board (current stage): ${list(scenes)}.${want !== 'board' ? ' write_scene makes a draft.' : ''}`)
  }

  /**
   * Run fn as a scene program that the agent can cancel: play_scene
   * stop/clear_queue/cancel, the client's cancel, and the session's end stop it.
   */
  private async withProgram<T>(session: Session, extra: ToolExtra, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const program = new AbortController()
    const clientCancel = (): void => program.abort()
    extra.signal?.addEventListener('abort', clientCancel, { once: true })
    if (extra.signal?.aborted) program.abort()
    this.programs.set(program, session.id)
    try {
      return await fn(program.signal)
    } finally {
      this.programs.delete(program)
      extra.signal?.removeEventListener('abort', clientCancel)
    }
  }

  /**
   * Make a draft match the board now: when the stage or the board changed
   * since the draft ran, run its program again (same seed) as a draft. Returns
   * why it ran again (or null), or the error.
   */
  private async freshDraft(session: Session, extra: ToolExtra, draft: Draft, force?: string): Promise<{ rerun: string | null } | CallToolResult> {
    try {
      return await this.withProgram(session, extra, (signal) =>
        this.staged(signal, async () => {
          const place = this.placeOf(draft.name)
          const context = await this.contextAt(place)
          this.stage.adopt(context)
          const reason = draftStale(draft, this.stage, context) ?? force ?? null
          if (!reason) return { rerun: null }
          const run = await this.stage.run(draft.source, context, { mode: 'draft', seed: draft.entry.seed, name: draft.name, signal, place })
          const liveError = await this.checkLivePrograms(livesOf(run.desc))
          if (signal.aborted) throw new SceneCancelled()
          if (liveError) throw liveError
          const next = await this.readyDraft(run, context, draft.name, draft.source, draft.seq, place)
          if (signal.aborted) throw new SceneCancelled()
          Object.assign(draft, next)
          return { rerun: reason }
        })
      )
    } catch (error) {
      if (error instanceof SceneProgramError) return failure(new Error(`The draft "${draft.name}" ran again because ${draftStale(draft, this.stage, null) ?? force ?? 'the board changed'} since write_scene, and its program failed now: ${error.message}\nNothing was drawn. Change the draft with write_scene.`))
      if (error instanceof SceneCancelled) return failure(error)
      throw error
    }
  }

  /** play_scene cut: the playing scene runs again, cut at a time, as a program that can be cancelled (see restage). */
  private async cutScene(session: Session, extra: ToolExtra, name: string | undefined, afterStep: number | string | undefined): Promise<CallToolResult> {
    const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args)) as Record<string, unknown>
    try {
      return await this.withProgram(session, extra, (signal) =>
        this.staged(signal, async () => {
          const playing = await control({ action: 'status' })
          if (!playing.playing_scene) return failure(new Error('No scene is playing, so there is nothing to cut.'))
          if (name && (playing.name as string | null) !== name) return failure(new Error(`The scene "${name}" is not the one that plays now (that is "${playing.name ?? playing.scene}"). cut acts on the playing scene only.`))
          const at = (await control({ action: 'cutTime', ...(afterStep !== undefined ? { after_step: afterStep } : {}) })) as unknown as { scene: string; at: number; duration: number }
          if (at.at >= at.duration - 1e-3) return text(json({ ...publicStatus(await control({ action: 'status' })), note: 'Nothing comes after that point: nothing was cut.' }))
          const status = await control({ action: 'status' })
          const out = await this.restage(at.scene, (status.waiting as string[]) ?? [], { cutAt: at.at }, signal)
          if ('content' in out) return out
          const scene = this.sceneName(at.scene)
          return text(json({ ...publicStatus(await control({ action: 'status' })), cut: { scene, at_s: at.at, length_s: out.main.duration_s }, ...(out.rerun.length ? { rerun: out.rerun } : {}) }))
        })
      )
    } catch (error) {
      if (error instanceof SceneCancelled) return failure(error)
      throw error
    }
  }

  /** play_scene start: the draft goes on the board and plays; a scene of the same name on the board is replaced in place. */
  private async startScene(session: Session, extra: ToolExtra, name: string | undefined, when: 'queue' | 'now', spans: Spans): Promise<CallToolResult> {
    if (!name) return failure(new Error('start needs name: the name of a draft from write_scene.'))
    const board = this.boardKey()
    const draft = this.draftsOf(board).get(name)
    if (!draft) {
      if (this.boardScene(name)) return failure(new Error(`No draft named "${name}": the scene "${name}" is on the board already and has no new version. replay plays it again; to change it, write_scene "${name}" first, then start.`))
      return failure(this.unknownScene(name, 'draft'))
    }
    const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args)) as Record<string, unknown>
    let outcome: CallToolResult | { result: SceneResult & { ends_in_s: number }; rerun: string | null; replaced: boolean; others?: unknown[]; stage?: string }
    const tQueue = Date.now()
    try {
      outcome = await this.withProgram(session, extra, (signal) =>
        this.staged(signal, async () => {
          spans.queue_ms = Date.now() - tQueue
          const onBoard = this.boardScene(name)
          if (onBoard?.scene) {
            const sceneId = onBoard.scene
            this.ownScene(session, sceneId)
            spans.scene = sceneId
            const known = await control({ action: 'known', scene: sceneId })
            if (!known.known) {
              return failure(
                new Error(`The scene "${name}" on the board can no longer be replaced: the board's player no longer holds it (the window reloaded or the board was opened again). Nothing was drawn, and the draft is kept. Give the new version another name with write_scene, and remove the old items in its program if they must go.`)
              )
            }
            const status = await control({ action: 'status' })
            const out = await this.restage(sceneId, (status.waiting as string[]) ?? [], { source: draft.source, seed: draft.entry.seed, name, when }, signal)
            if ('content' in out) return out
            return { result: out.main, rerun: 'it replaces the scene on the board, so it ran at that scene\'s place on the stage', replaced: true, others: out.rerun }
          }
          const context = (await this.board('sceneContext', {})) as SceneContext
          this.stage.adopt(context)
          let reason = draftStale(draft, this.stage, context)
          /** Run the program again as a scene at the end of the stage, and commit it with its frames. */
          const runAndCommit = async (): Promise<{ result: SceneResult & { ends_in_s: number }; entry: StageEntry; fresh: string | null }> => {
            const run = await this.stage.run(draft.source, context, { mode: 'scene', seed: draft.entry.seed, name, signal })
            Object.assign(spans, run.timing)
            const liveError = await this.checkLivePrograms(livesOf(run.desc))
            if (signal.aborted || liveError) {
              this.stage.discard(run.entry)
              throw liveError ?? new SceneCancelled()
            }
            try {
              const tCommit = Date.now()
              const result = (await this.board('runScene', { scene: run.desc, job: run.job, frames: run.frames, when, name }, SCENE_TIMEOUT_MS)) as SceneResult & { ends_in_s: number }
              spans.commit_ms = Date.now() - tCommit
              return { result, entry: run.entry, fresh: run.fresh }
            } catch (error) {
              this.stage.discard(run.entry)
              throw error
            }
          }
          let done: { result: SceneResult & { ends_in_s: number }; entry: StageEntry; fresh: string | null }
          if (reason) done = await runAndCommit()
          else {
            this.stage.adoptDraft(draft.entry)
            let out: unknown
            try {
              const tCommit = Date.now()
              out = await this.board('runScene', { draft: draftKey(draft.desc), when, name }, SCENE_TIMEOUT_MS)
              spans.commit_ms = Date.now() - tCommit
            } catch (error) {
              this.stage.discard(draft.entry)
              throw error
            }
            if (isMissing(out)) {
              // The board no longer holds the draft (its window loaded again, or newer drafts took its place): it runs again.
              this.stage.discard(draft.entry)
              reason = 'the board no longer held the draft'
              done = await runAndCommit()
            } else done = { result: out as SceneResult & { ends_in_s: number }, entry: draft.entry, fresh: draft.fresh }
          }
          const { result, entry, fresh } = done
          entry.scene = result.scene
          await this.recordCommit(entry, result)
          this.ownScene(session, result.scene)
          spans.scene = result.scene
          return { result, rerun: reason, replaced: false, ...(fresh ? { stage: `new (${fresh})` } : {}) }
        })
      )
    } catch (error) {
      if (error instanceof SceneProgramError) return failure(new Error(`The draft "${name}" ran again because ${draftStale(draft, this.stage, null) ?? 'the board changed'} since write_scene, and its program failed now: ${error.message}\nNothing was drawn, and the draft is kept. Change it with write_scene.`))
      if (error instanceof SceneCancelled) return failure(error)
      throw error
    }
    if ('content' in outcome) return outcome
    // The draft is used up (a newer version that became ready since stays).
    if (this.draftsOf(board).get(name) === draft) this.draftsOf(board).delete(name)
    const { result } = outcome
    console.log(`mcp: play_scene start ${name}${outcome.replaced ? ' (replaces the scene on the board)' : ''}: ${result.duration_s} s, starts in ${result.starts_in_s} s`)
    const body: Record<string, unknown> = {
      scene: name,
      ...(outcome.replaced ? { replaced: 'the earlier version on the board (one undo step for the learner)' } : {}),
      ...(outcome.rerun && !outcome.replaced ? { ran_again: `because ${outcome.rerun} since write_scene` } : {}),
      length_s: result.duration_s,
      starts_in_s: result.starts_in_s,
      ends_in_s: result.ends_in_s,
      steps: result.steps,
      items: itemsSummary(result.items, name),
      ...(result.log.length ? { log: result.log } : {}),
      ...(outcome.others?.length ? { rerun: outcome.others } : {}),
      ...(outcome.stage ? { stage: outcome.stage } : {})
    }
    return text(json(body))
  }
}

class BodyTooLarge extends Error {}

/** The JSON body. Past MAX_BODY_BYTES the rest is read and dropped, so the client still gets a clear answer. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
      else chunks.length = 0
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge(`The request is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB. Send less per call.`))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The stage entries of the scenes restored from the records (scene-store.ts restorable), in order, each
 * with the stage ids it took (source.range). A scene whose code is missing, whose record is of the
 * older key scheme (its keys cannot link its objects to its nodes), or whose line is malformed
 * (problem: checked at the record boundary) is marked (StageEntry.failed).
 */
function entriesOf(scenes: RestorableScene[]): StageEntry[] {
  return scenes.map(({ line, source, missing, legacy, problem }) => {
    const base = { scene: line.scene, source, name: line.name, seed: line.source.seed }
    if (problem) return { ...base, cutAt: null, ctxText: '{}', answers: new Map(), failed: `its record line is malformed (${problem})` }
    const keys = line.story.items.filter((item) => item.made && !item.key.startsWith('node:')).map((item) => item.key)
    const failed = missing.length
      ? `its code is missing (${missing.join(', ')})`
      : legacy
        ? 'it was recorded before scenes could be rebuilt after a restart'
        : new Set(keys).size !== keys.length
          ? 'its record names an object twice'
          : undefined
    return { ...base, cutAt: line.source.cutAt, ctxText: line.source.ctx, answers: new Map(line.source.answers), ...(line.source.range ? { range: line.source.range } : {}), ...(failed ? { failed } : {}) }
  })
}
