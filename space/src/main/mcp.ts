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
  type CanvasInfo
} from '@shared/space-api'

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

const COORDINATES_NOTE =
  'Board coordinates are logical points with the origin at the board centre, +x to the right and +y down. Rects are {x, y, width, height} with (x, y) the top-left corner.'

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
  /**
   * Per board: where the first get_changes since the last "changes" screenshot
   * started. A "changes" screenshot starts here, so get_changes followed by
   * get_screenshot("changes") shows the items that get_changes listed.
   */
  listedFrom: Map<string, number>
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

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** A scene as the agent names it: its name (a replay says so), else its id. */
function sceneLabel(id: unknown, name: unknown): string | null {
  if (typeof id !== 'string') return null
  if (typeof name !== 'string' || !name) return id
  return /~r\d+$/.test(id) ? `${name} (replay)` : name
}

/** play_scene's status as the agent sees it: scenes by name (the renderer adds ids and fields for the main process). */
function publicStatus(status: unknown): Record<string, unknown> {
  const { waiting: _waiting, playing_scene: _playing, scene, name, paused_scene, paused_name, queue, ...rest } = (status ?? {}) as Record<string, unknown>
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

/** The play_scene actions besides start (see the play_scene tool). */
const PLAY_ACTIONS = ['start', 'status', 'pause', 'resume', 'next', 'stop', 'clear_queue', 'cancel', 'wait', 'replay', 'cut', 'reset'] as const
/** At most this many moments in one preview_scene list. */
const MAX_PREVIEW_FRAMES = 12
/** The longest side of a one-frame preview, in pixels. */
const SINGLE_FRAME_EDGE = 1024

/** A draft scene (write_scene): its program, and its run on the stage and board as they were then. Its frames and its compile are in the renderer, under draftKey(desc). */
interface Draft {
  name: string
  code: string
  desc: SceneDescription
  /** The run, ready to join the stage's log when it plays unchanged (its seed is kept when it runs again). */
  entry: StageEntry
  fresh: string | null
  revision: number
  epoch: string
  contextKey: string
  /** The order of the write_scene calls: a draft never takes the place of a newer one. */
  seq: number
  /** What the board's compile found (write_scene's result). */
  info: DraftInfo
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
type LiveCheck = Pick<SceneLiveObject, 'api' | 'mode' | 'code' | 'params' | 'width' | 'height' | 'line'>
const livesOf = (desc: SceneDescription): LiveCheck[] => desc.objects.filter((object): object is SceneLiveObject => object.kind === 'live')

const isMissing = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { draftMissing?: unknown }).draftMissing === true

/** Why a draft must run again before it is shown or played (the stage or the board changed since it ran), or null. */
function draftStale(draft: Draft, stage: SceneStage, context: SceneContext | null): string | null {
  if (draft.epoch !== stage.epoch) return 'the stage started new'
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
    async (request) => this.bridge.request('sceneHost', { request }, WRITE_TIMEOUT_MS)
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

  constructor(private readonly hooks: AgentServerHooks) {
    this.bridge = new RendererBridge(hooks.webContents)
    this.news = new BoardNews({
      request: (since) => this.bridge.request('learnerNews', { since }, NEWS_TIMEOUT_MS),
      folderRoot: () => hooks.folderRoot(),
      shownBoard: () => hooks.shownBoard()
    })
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
      cursors: new Map(),
      listedFrom: new Map()
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
      cursors: new Map(),
      listedFrom: new Map()
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

  /** Wrap a tool body: activity pulse, logging, errors as tool errors, the session trace. */
  private tool<A>(session: Session, name: string, body: (args: A, extra: ToolExtra) => Promise<CallToolResult>) {
    return async (args: A, extra?: ToolExtra): Promise<CallToolResult> => {
      session.lastActivity = Date.now()
      this.hooks.activity({ sessionId: session.id, tool: name })
      const start = Date.now()
      // The board news goes out once, before the tool runs (a screenshot then counts as a look after it).
      // get_changes gets none: it lists the same changes itself.
      const news = name === 'get_changes' ? '' : await this.newsLine(session)
      let result: CallToolResult
      let thrown: unknown = null
      try {
        result = await body(args, extra ?? {})
      } catch (error) {
        console.warn(`mcp: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
        thrown = error
        result = failure(error)
      }
      if (news) result = { ...result, content: [{ type: 'text', text: news }, ...result.content] }
      this.traceOf(session)?.call(name, args, start, Date.now(), this.hooks.shownBoard(), thrown === null ? result : null, thrown)
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
      session.listedFrom.delete(path)
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
    change: { code?: string; seed?: number; cutAt?: number; name?: string; when?: 'queue' | 'now' },
    signal: AbortSignal
  ): Promise<CallToolResult | { main: SceneResult & { ends_in_s: number }; rerun: Array<{ scene: string; ok: boolean; error?: string; starts_in_s?: number }> }> {
    const control = (args: Record<string, unknown>): Promise<unknown> => this.board('sceneControl', args, SCENE_TIMEOUT_MS)
    const stopped = (): void => {
      if (signal.aborted) throw new SceneCancelled()
    }
    stopped()
    const playingNow = ((await control({ action: 'status' })) as { playing_scene?: { id: string } | null }).playing_scene?.id
    stopped()
    const live = (id: string): boolean => waiting.includes(id) || playingNow === id
    const label = change.name ?? this.sceneName(sceneId)
    const cut = this.stage.truncateBefore(sceneId)
    if (!cut) return failure(new Error(`The scene "${label}" is not part of the current stage (it ran before the stage started new).`))
    const later = cut.later
    // Every later scene comes off the board too: it is committed again from its new run.
    const affected = [sceneId, ...later.map((entry) => entry.scene).filter((id): id is string => !!id)]
    // The reverts and every commit of the restage are one undo step for the learner (Board agentCommit's step key).
    const step = `restage-${sceneId}-${Date.now()}`
    const commit = async (id: string, run: StageRun, name: string | null, extra: Record<string, unknown> = {}): Promise<SceneResult & { ends_in_s: number }> =>
      (await this.board('runScene', { scene: run.desc, job: run.job, frames: run.frames, sceneId: id, slot: true, step, ...(name ? { name } : {}), ...extra }, SCENE_TIMEOUT_MS)) as SceneResult & { ends_in_s: number }
    /** Run a program: on the context, answers and seed of its earlier run (original), or on the board now. */
    const runOne = async (code: string, options: { seed?: number; cutAt: number | null; original?: StageEntry; name: string | null }): Promise<StageRun> => {
      const context = options.original ? (JSON.parse(options.original.ctxText) as SceneContext) : ((await this.board('sceneContext', {})) as SceneContext)
      // The same program on the same context gets the board's answers of its first run (html sizes, empty places).
      const run = await this.stage.run(code, context, { mode: 'scene', seed: options.seed, cutAt: options.cutAt, name: options.name, answers: options.original?.answers, signal })
      const liveError = await this.checkLivePrograms(livesOf(run.desc))
      if (liveError || signal.aborted) {
        this.stage.discard(run.entry)
        throw liveError ?? new SceneCancelled()
      }
      return run
    }
    /**
     * The earlier state again: the log as it was before this scene, every
     * affected scene's items off the board, then the scene and the ones after
     * it run as they ran before (same context, answers, seed and cut) and go
     * back on the board in the same undo step. A scene that waited or played,
     * or that the player holds now (a replaced scene that plays again), takes
     * its place in the queue again; a scene that has played comes back in its
     * end state. A restore cannot be cancelled: these programs ran to their
     * end before.
     */
    const restore = async (): Promise<void> => {
      this.stage.truncate(cut.index)
      await control({ action: 'revert', scenes: affected, step })
      const now = (await control({ action: 'status' })) as { waiting?: string[]; playing_scene?: { id: string } | null }
      const held = new Set([...(now.waiting ?? []), ...(now.playing_scene ? [now.playing_scene.id] : [])])
      for (const entry of [cut.entry, ...later]) {
        const run = await this.stage.run(entry.code, JSON.parse(entry.ctxText) as SceneContext, { mode: 'scene', seed: entry.seed, cutAt: entry.cutAt, name: entry.name, answers: entry.answers })
        if (!entry.scene) continue
        await commit(entry.scene, run, entry.name, live(entry.scene) || held.has(entry.scene) ? {} : { settled: true })
        run.entry.scene = entry.scene
      }
    }
    let main: SceneResult & { ends_in_s: number }
    const rerun: Array<{ scene: string; ok: boolean; error?: string; starts_in_s?: number }> = []
    try {
      await control({ action: 'revert', scenes: affected, step })
      stopped()
      const run =
        change.code !== undefined
          ? await runOne(change.code, { seed: change.seed, cutAt: null, name: change.name ?? cut.entry.name })
          : // A cut runs the same program with the same seed and context, so it is the same up to the cut.
            await runOne(cut.entry.code, { seed: cut.entry.seed, cutAt: change.cutAt ?? null, original: cut.entry, name: cut.entry.name })
      main = await commit(sceneId, run, run.entry.name, change.when ? { when: change.when } : {})
      run.entry.scene = sceneId
      for (const entry of later) {
        const id = entry.scene
        const queued = !!id && waiting.includes(id)
        try {
          // A waiting scene runs on the board as it is now; a scene that has played keeps its earlier context. Each keeps its cut.
          const run = await runOne(entry.code, { seed: entry.seed, cutAt: entry.cutAt, name: entry.name, ...(queued ? {} : { original: entry }) })
          run.entry.scene = id
          if (queued && id) {
            const result = await commit(id, run, entry.name)
            rerun.push({ scene: entry.name ?? id, ok: true, starts_in_s: result.starts_in_s })
          } else if (id) {
            await commit(id, run, entry.name, { settled: true })
            rerun.push({ scene: entry.name ?? id, ok: true })
          }
        } catch (error) {
          if (error instanceof SceneCancelled || signal.aborted) throw error
          if (queued && id) await control({ action: 'drop', scene: id })
          rerun.push({ scene: entry.name ?? id ?? '?', ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      // The scenes stay as they were (a scene that has played is not played again).
      await restore()
      if (error instanceof SceneCancelled || signal.aborted) throw new SceneCancelled()
      const failed = error instanceof Error ? error.message : String(error)
      return failure(
        new Error(
          change.code !== undefined
            ? `play_scene start failed, and the scene "${label}" on the board stays as it was: ${failed}\nThe draft is kept. Change it with write_scene.`
            : `cut failed, and the scene "${label}" stays as it was: ${failed}`
        )
      )
    }
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
    failed.sort((a, b) => (a.live.line ?? 0) - (b.live.line ?? 0))
    const what = (entry: { live: Live; error: string }): string => `the ${entry.live.api}() code ${entry.live.mode === 'program' ? 'fails' : 'does not compile'}: ${entry.error}`
    if (failed.length === 1) return new SceneProgramError(what(failed[0]), failed[0].live.line ?? null)
    return new SceneProgramError(failed.map((entry) => (entry.live.line ? `Line ${entry.live.line}: ${what(entry)}` : what(entry))).join('\n'), null)
  }

  private board(tool: AgentToolName, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.bridge.request('agentTool', { tool, args }, timeoutMs)
  }

  /**
   * A draft run that ended in the stage (its frames are in the renderer):
   * the renderer compiles it and keeps it under its key. Then it is ready.
   */
  private async readyDraft(run: StageRun, context: SceneContext, name: string, code: string, seq: number): Promise<Draft> {
    const info = (await this.board('sceneDraft', { scene: run.desc, job: run.job, frames: run.frames, draft: draftKey(run.desc) }, SCENE_TIMEOUT_MS)) as DraftInfo
    return { name, code, desc: run.desc, entry: run.entry, fresh: run.fresh, revision: this.stage.revision, epoch: this.stage.epoch, contextKey: contextKey(context), seq, info }
  }

  private infoText(info: CanvasInfo): string {
    return json({ ...info, coordinates: COORDINATES_NOTE })
  }

  private registerTools(session: Session): void {
    const server = session.server

    server.registerTool(
      'get_canvas_info',
      {
        title: 'Canvas info',
        description:
          "Returns the current state of Learning Space as structured text: the learning folder (name and absolute path), the open board and the other boards in the folder, the learner's visible view and the bounds of all content, node counts by kind, the top-level nodes (id, kind, name, author, bounds), the ink groups (id such as \"g3\", author, parent, stroke count, bounds), the learner's selection and current tool, and your change cursor.\n\nUse it when you start work on a board, and whenever you need ids, sizes or free areas. It returns no image: to see what is written or drawn, use get_screenshot.\n\n- Coordinates are board points: origin at the centre, +x right, +y down.\n- covered (when present) lists the parts of the view that the app's script panel and tool palette cover while scenes play; the learner cannot see material there.\n- How the app groups strokes into ink groups, and how their ids behave, is in get_guide topic \"model\".",
        inputSchema: {},
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_canvas_info', async () => {
        const info = await this.bridge.request('canvasInfo', {})
        this.touchCursor(session, info)
        return text(this.infoText(info))
      })
    )

    server.registerTool(
      'get_screenshot',
      {
        title: 'Screenshot of the board',
        description:
          "Renders part of the open board to a PNG image, the way the learner sees it (ink, text, maths, drawings, images; no app interface), with a text that maps image pixels to board points.\n\nUse it to read handwriting and to see how a drawing looks. For ids, sizes and structure, get_canvas_info and get_tree are much smaller.\n\n- What to capture: node_id (one node or ink group, with a small margin), region (an exact board rect), or target: \"viewport\" (what the learner sees now; the default), \"content\" (the whole board), \"selection\" (what the learner selected) or \"changes\".\n- target \"changes\" shows only what changed since your last \"changes\" screenshot: items added, moved, resized or edited in dashed blue boxes, removed items in dashed pink boxes. It moves your change cursor.\n- Any area works, also outside the learner's view.\n- labels: true adds id tags and outlines; grid: true adds board coordinates every 100 points. Both appear only in your image.\n- While a scene plays, the image shows the board at that moment, not the scene's end state, and the text says so.\n- Large areas make large images. A node_id or a small region gives the sharpest view of handwriting.",
        inputSchema: {
          node_id: z.string().optional().describe('Capture this node (frame, text, svg, image or ink) or ink group ("g3").'),
          region: rectSchema.optional().describe('Capture this board rect.'),
          target: z.enum(['viewport', 'content', 'selection', 'changes', 'region']).optional().describe('What to capture when there is no node_id or region.'),
          scale: z.number().positive().max(4).optional().describe('Image pixels per board point (default 1). Lowered when the image would exceed max_size.'),
          max_size: z.number().int().min(256).max(4096).optional().describe('The longest image side in pixels. Default: 1024 for target "viewport" and "content" and for any area longer than 1000 board points; 1600 for smaller node and region crops.'),
          labels: z.boolean().optional().describe('Draw id tags and outlines on the image (default false).'),
          grid: z.boolean().optional().describe('Draw a board-coordinate grid on the image (default false).')
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_screenshot', async ({ node_id, region, target, scale, max_size, labels, grid }) => {
        const kind = node_id ? 'node' : region && (!target || target === 'region') ? 'region' : (target ?? 'viewport')
        let since: number | null = null
        if (kind === 'changes') {
          const info = await this.bridge.request('canvasInfo', {})
          this.touchCursor(session, info)
          const board = info.board?.path
          since = board ? (session.listedFrom.get(board) ?? session.cursors.get(board) ?? null) : null
        }
        const plan = await this.bridge.request('screenshotPlan', {
          target: kind,
          region,
          nodeId: node_id,
          scale: scale ?? 1,
          maxSize: max_size ?? null,
          since,
          labels: labels ?? false,
          grid: grid ?? false
        })
        if (kind === 'changes') {
          session.cursors.set(plan.board, plan.cursor)
          session.listedFrom.delete(plan.board)
        } else if (!session.cursors.has(plan.board)) {
          session.cursors.set(plan.board, this.startCursor(session, plan.board, plan.cursor))
        }
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
        const what = node_id ? `node ${node_id}` : `target "${kind}"`
        const playing = plan.playing
        const lines = [
          `Board "${plan.board}", ${what}.`,
          ...(playing
            ? [
                `A live scene ${playing.paused ? 'is paused' : 'is playing'} (${playing.name ? `"${playing.name}"` : playing.scene}, ${playing.t ?? 0} s of ${playing.duration ?? 0} s${playing.step ? `, step "${playing.step}"` : ''}): the image shows the board as the learner sees it at this moment, not the scene's end state.`
              ]
            : []),
          `The image (${shot.width}×${shot.height} px) covers the board rect ${json(plan.rect).replace(/\s+/g, ' ')} at ${plan.scale} px per board point.`,
          'Image pixel (px, py) is board point (x + px / scale, y + py / scale).'
        ]
        if (plan.overlays.labels.length) {
          lines.push(`Id tags (yellow = learner ink group, green = your ink group, blue = node): ${plan.overlays.labels.map((label) => label.text).join(', ')}.`)
        }
        if (plan.overlays.grid) lines.push(`Grid lines every ${plan.overlays.grid} board points, numbered on the top and left edges.`)
        if (shot.missingImages) lines.push(`${shot.missingImages} image(s) did not load and show as empty.`)
        if (plan.changes) {
          lines.push(
            `Dashed blue boxes: ${plan.changes.changed} new or changed item(s). Dashed pink boxes: erased items (${plan.changes.removed} in all; the image is cropped to the new material, so get_changes lists erased items outside it). Your change cursor is now ${plan.cursor}.`
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
        description:
          "Lists what changed on the open board since your change cursor, as JSON: items added or changed (id, kind, tool, colour, name, by, change, offset, bounds, seq), items removed (id, kind, name, by, bounds, seq), the ink groups that hold changed strokes (groups_changed), and your new cursor.\n\nUse it to learn what the learner did since you last looked. It returns no image; to see the items, use get_screenshot with target \"changes\" or a node_id.\n\n- Your cursor starts where your app last looked at this board in an earlier connection; otherwise at your first look in this one (get_canvas_info, get_changes, get_screenshot or open_board), so the first call then lists nothing new.\n- since: 0 lists the whole history of the board.\n- The list includes your own writes; by tells them apart from the learner's.\n- change says what happened to the item since your cursor: added, restored (it was on the board before, was removed, and is back with the same id, by undo, redo or paste), moved (offset: dx, dy in board points), resized, edited (its content), changed (anything else, or not known), or unchanged (changed and changed back).\n- Board news: when the learner drew, erased, added, restored, moved, resized, edited or deleted something since your app's last look or last board news, the next result of any tool starts with a \"Board news\" line that names each change: strokes by ink group and place, other items by kind and name, with the offset of a move and the new bounds. Each change is in the news once, kept per agent app and board across connections.",
        inputSchema: {
          since: z.number().int().min(0).optional().describe('A cursor value to compare against instead of your own cursor; 0 lists the whole history.')
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_changes', async ({ since }) => {
        // since: 0 means "everything": -1 also catches items from files that carry no seq (seq 0).
        let from: number | null = since === undefined ? null : since === 0 ? -1 : since
        if (from === null) {
          const info = await this.bridge.request('canvasInfo', {})
          this.touchCursor(session, info)
          from = info.board ? (session.cursors.get(info.board.path) ?? null) : null
        }
        const changes = await this.bridge.request('changes', { since: from })
        if (from !== null && !session.listedFrom.has(changes.board)) session.listedFrom.set(changes.board, from)
        session.cursors.set(changes.board, changes.cursor)
        await this.looked(session, changes.board, changes.cursor)
        return text(json(changes))
      })
    )

    server.registerTool(
      'open_board',
      {
        title: 'Open a board',
        description:
          "Opens another board of the learning folder in the app, so that the learner and you both see it; the learner's view switches to it. Returns the canvas info of the opened board, as get_canvas_info does.\n\nUse it when the learner asks for another board, or when the work belongs on a board that already exists. get_canvas_info lists the boards.",
        inputSchema: { path: z.string().describe('Relative to the learning folder, ending in .board.json, for example "boards/Fractions.board.json".') }
      },
      this.tool(session, 'open_board', async ({ path }) => {
        const info = await this.bridge.request('openBoard', { path })
        this.touchCursor(session, info)
        return text(this.infoText(info))
      })
    )

    server.registerTool(
      'get_brief',
      {
        title: 'The Learning Space brief',
        description:
          "Returns the Learning Space brief as markdown (about 12,000 characters): what the space is for and your part in it, how to find out what the person wants, how to read their work, how to explain by drawing one step at a time, what can go on the board, talking, checking facts, and the learning folder as memory.\n\nUse it at the start of a session when the brief is not in your context. In a learning folder it already is: the folder's AGENTS.md holds the same text. Agents started outside a learning folder, such as Claude Desktop, need this call.\n\n- It holds no technical details of the board; get_guide has those.\n- No parameters.",
        inputSchema: {},
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_brief', async () => text(briefText()))
    )

    server.registerTool(
      'get_guide',
      {
        title: 'The board reference',
        description: `Returns one topic of the board reference as markdown: the technical details of the board and of scenes (write_scene, preview_scene, play_scene), the one way to write on it.\n\nUse it before a scene that uses something whose details are not in your context yet: topic "scene" before your first write_scene${htmlMaterial(', topic "html" before your first html() material')}.\n\nTopics:\n${guideTopics(this.hooks.folderRoot())}\n\n- Topics are about 500 to 16,000 characters; "scene" is the longest${codeItems(', and "scene-interact" holds about 12,000 characters of source')}.\n- Without topic, it returns all topics in one text (about 41,000 characters).\n- An unknown topic returns an error that lists the topic names.\n- It does not hold the brief (what the space is for and how you work with the person); get_brief has it.`,
        inputSchema: {
          topic: z.string().optional().describe(`A topic name from the list in the description, such as "scene" or ${htmlMaterial('"html"', '"ink"')}. Without it, all topics.`)
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_guide', async ({ topic }) => text(guideText(this.hooks.folderRoot(), topic)))
    )

    server.registerTool(
      'get_tree',
      {
        title: 'Node tree',
        description:
          "Returns a compact text outline of the open board, or of one node and its children: one line per node with kind, name, id and bounds (\"x,y w×h\"). Text nodes show their first words; ink shows as ink groups with author and stroke count under their parent.\n\nUse it to find ids and to see how material is grouped. It is much smaller than a screenshot and shows no pixels.",
        inputSchema: {
          node_id: z.string().optional().describe('Outline only this node and its children. Default: the whole board.'),
          depth: z.number().int().min(1).max(10).optional().describe('How many levels inside frames to list, 1 to 10. Default 3.')
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_tree', async (args) => text(String(await this.board('getTree', args))))
    )

    server.registerTool(
      'get_node_info',
      {
        title: 'Node details',
        description:
          "Returns every stored detail of one node or ink group as JSON: kind, name, author, parent, children ids, bounds on the board and inside the parent, z order, style, text with markup, SVG element ids, image source, or for ink the tool, colour, width and point count. For an ink group it lists the group's strokes and their bounds.\n\nUse it when you need exact values before you change a node. For an overview of many nodes, get_tree is smaller.",
        inputSchema: { node_id: z.string().describe('A node id, or an ink group id such as "g3".') },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_node_info', async (args) => text(json(await this.board('getNodeInfo', args))))
    )

    // Lab switch LS_LAB_NO_HTML (lab-switch.ts): no HTML material, so no get_html.
    if (!NO_HTML) server.registerTool(
      'get_html',
      {
        title: 'Node as HTML',
        description:
          "Returns a node and everything inside it as the HTML subset that a scene's html() takes, with inline styles.\n\nUse it to restructure existing material: change the HTML, then put it back in a scene with html(markup, {into: board.node(id), mode: \"replace\"}).\n\n- Ink is not HTML: it appears as a comment, and a replace leaves it out.",
        inputSchema: {
          node_id: z.string().describe('The node to export, with everything inside it.'),
          include_ids: z.boolean().optional().describe('Add data-id attributes for reference (default true). html() does not reuse them; new material gets new ids.')
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_html', async (args) => text(String(await this.board('getHtml', args))))
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
          "move the camera and a pointer; and show lines of text for the learner to read (say). The complete reference is get_guide topic \"scene\".\n\nUse it for everything you draw, write, place, change or remove on the board. To check how a scene looks before the learner sees it, use preview_scene; to look at the board itself, use get_screenshot, get_canvas_info and get_changes.\n\nHow it runs:\n- The program runs in a sandbox with no access to the app, files or network. It may compute for as long as it needs; play_scene \"cancel\" stops it.\n- Every program on a board runs on the same stage, one after another. What a program puts on the global `stage` object stays for later programs, and objects of earlier programs can be acted on again. A draft reads the stage as it is when you write it, and joins the stage when it starts. The stage starts new when the board changes, on play_scene \"reset\", and when the app starts.\n- A name holds one draft, so writing the same name again replaces it. To change a scene that is already on the board, write it again under its name and start it: the new version takes the place of the old one.\n- Drafts live in the app's memory and are lost when the app quits.\n- Coordinates are board points: origin at the centre, +x right, +y down.\n\nReturns JSON: draft (the name), replaces (when a scene of this name is on the board), changed (when an earlier draft of this name was replaced), length_s, steps ([{number, name, start_s, length_s, pause?}]), items ({total, by_kind, named, removed_by_end}), say_lines (how many), log (console.log output), warnings (unknown options and other mistakes in the program), and stage (only when this program started a new stage: why).\n\nErrors: a program error returns its message and line number. The stage stays as it was before the program, and the result says whether an earlier draft of this name is kept.",
        inputSchema: {
          name: z.string().min(1).max(MAX_NAME_CHARS).describe('The scene\'s name, such as "synapse". preview_scene and play_scene find the scene by it, and it also shows in the board news, the learner\'s script panel, logs and traces. Writing the same name again replaces this scene.'),
          code: z
            .string()
            .min(1)
            .describe('The program: the body of an async function, so top-level await works. Example: const c = circle(0, 0, 80); await draw(c); await label(c, "r")')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
      },
      this.tool(session, 'write_scene', async ({ name, code }, extra) => {
        const board = this.boardKey()
        const before = this.draftsOf(board).get(name)
        const onBoard = this.boardScene(name)
        const seq = ++this.draftSeq
        // The draft is ready when the call returns: its program ran, its frames are in the renderer, the renderer compiled it.
        const outcome = await this.withProgram(session, extra, (signal) =>
          this.stage.exclusive(async (): Promise<CallToolResult | Draft> => {
            const context = (await this.board('sceneContext', {})) as SceneContext
            const run = await this.stage.run(code, context, { mode: 'draft', name, signal })
            const liveError = await this.checkLivePrograms(livesOf(run.desc))
            if (signal.aborted) throw new SceneCancelled()
            if (liveError) throw liveError
            const draft = await this.readyDraft(run, context, name, code, seq)
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
            ...(onBoard ? { replaces: `the scene "${name}" on the board (play_scene start replaces it in place)` } : {}),
            ...(before ? { changed: 'the earlier version of this draft' } : {}),
            length_s: info.duration_s,
            steps: info.steps,
            items: info.items,
            say_lines: info.cues.length,
            ...(info.log.length ? { log: info.log } : {}),
            ...(info.warnings.length ? { warnings: info.warnings } : {}),
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
          "Shows you a scene as one image: a draft from write_scene, or a scene already on the board. Nothing is drawn or committed, and the learner sees nothing.\n\nUse it to check a scene before the learner sees it. You can look at its end, at any step or at any moment, and close up on one part, so that text a line runs through, text over text, or something outside the learner's view is caught before the scene plays. To see the board itself as it is now, with the learner's ink, use get_screenshot.\n\n- at chooses the moments. \"end\" (default) is the end of the scene. {step: 3} or {step: \"step name\"} is the end of that step. {time_s: 12.5} is that many seconds from the scene's start. \"steps\" is the end of every step. A list gives up to 12 moments, for example [{step: 2}, {time_s: 20}, \"end\"].\n- part chooses what the image frames. \"scene\" (default) is everything the scene makes or touches. \"view\" is the learner's current view. {region: {x, y, width, height}} is a region in board points. {items: [...]} is a close-up of one or more items: object names from the program, item ids, or ink group ids.\n- One moment gives a large image (up to 1024 px on its longer side), which shows small text. Several moments give one grid of labelled frames.\n- The scene is drawn over the board as it is now, and the learner's current view is outlined in grey." +
          codeItems(" Code items compute up to each moment.") +
          "\n- version \"board\" shows the scene on the board when a draft of the same name also exists. The default is the draft when there is one, else the scene on the board.\n- A scene on the board shows its items as they were at each moment. After the board is opened again, a scene on the board can no longer be previewed; use get_screenshot for it.\n- When the board or the stage changed since write_scene, the draft runs again with the same seed before the pictures (ran_again says why).\n\nReturns the image and JSON: scene, version (\"draft\" or \"board\"), ran_again, length_s, and frames ([{frame, t_s, label}]).\n\nErrors: an unknown name lists the drafts and the scenes on the board; an unknown step lists the steps; a time after the end gives the scene's length.",
        inputSchema: {
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
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'preview_scene', async ({ name, at, part, version }, extra) => {
        const board = this.boardKey()
        const draft = this.draftsOf(board).get(name)
        const onBoard = this.boardScene(name)
        const use = version ?? (draft ? 'draft' : onBoard ? 'board' : null)
        if (use === null || (use === 'draft' && !draft) || (use === 'board' && !onBoard)) return failure(this.unknownScene(name, use))
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
        const image = await renderStoryboard(this.hooks.snapshots, { nodes: plan.nodes, frames: plan.frames, rect: plan.rect, view: plan.view, covered: plan.covered, background: plan.background, stills }, options)
        const ticks = stills.length ? `; live stills ${stills.filter((still) => still.url).length}/${stills.length} in ${stillsMs} ms at ticks ${stills.map((still) => still.tick ?? '-').join(',')}` : ''
        console.log(`mcp: preview_scene ${name} (${use}): ${plan.frames.length} frame(s), ${image.width}x${image.height}; frames ${framesMs} ms, picture ${Date.now() - pictureStart} ms${ticks}`)
        const summary = {
          scene: name,
          version: use === 'draft' ? 'draft (not on the board)' : 'on the board',
          ...(rerun ? { ran_again: rerun } : {}),
          length_s: plan.duration_s,
          frames: plan.frames.map((frame, i) => ({ frame: i + 1, t_s: frame.t, label: frame.label })),
          image: `${plan.frames.length} frame(s)${single ? '' : ` in ${image.columns} column(s), read left to right`}; each covers the board rect ${JSON.stringify(plan.rect)} at ${Math.round(image.scale * 100) / 100} px per board point. The learner's view is outlined in grey.`
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
          "Plays scenes from write_scene for the learner, and controls their playback and the stage they run on. The learner sees everything this tool does.\n\nActions:\n- \"start\" (name, when, wait): puts the draft of that name on the board and plays it. If a scene of that name is already there, the new version takes its place: a waiting scene keeps its place in the queue, a playing scene goes on from the same time, and a scene that has played comes off the board and plays again. Starting uses up the draft, so a later change begins with write_scene again.\n- \"status\" changes nothing.\n- \"pause\" holds the playing scene where it is. \"resume\" continues a paused scene: after a pause step, after the learner's drawing paused it, or after \"pause\".\n- \"next\" jumps the playing scene to the start of its next step and plays on, also from a pause. At the last step it ends the scene.\n- \"stop\" jumps the playing scene to its end state; the next waiting scene starts.\n- \"clear_queue\" drops the scenes that wait in the queue, takes their items off the board and their programs off the stage.\n- \"cancel\" ends scene programs that are still running (write_scene and start calls that have not returned). Their call returns an error that starts with \"Cancelled\", and nothing of them is drawn. A program has no time limit, so this is how one that never ends is stopped. \"stop\" and \"clear_queue\" also end them.\n- \"wait\" returns when nothing plays or waits, or when a scene stands paused (paused_by says why).\n- \"replay\" (name and/or from_step, when) plays again a scene that has already played, from its start or from the step. Its items show as they were at that moment and play to its end; then the board shows its current state.\n- \"cut\" (after_step) drops the rest of the playing scene after that step, or from now without after_step. What starts later is not drawn, and what runs then holds where it is. With name, it acts only when that scene plays.\n- \"reset\" starts a new, empty stage. Board items stay; objects, values and `stage` from earlier programs are gone.\n\nHow playback works:\n- A scene started while another plays starts when that one ends, after the scenes already waiting, with no gap. when: \"now\" starts it at once, over the others.\n- A step with {pause: true} holds playback until \"resume\" or \"next\". When the learner starts drawing, playback pauses at the next step (or at once when no step is left), and the board news says so.\n- say lines are shown as text at a reading pace; nothing is spoken.\n\nAfter a scene plays, everything stays as ordinary items the learner can edit: ink (one ink group per ink object), svg nodes (shapes), text nodes (tex, text), " +
          htmlMaterial("html() material and ") +
          "image() material (its root node with everything inside), " +
          codeItems("live items, ") +
          "and one frame per named group. What the scene erased or faded out is gone. start, cut and clear_queue are each one undo step for the learner, and the board file holds the final state from the moment the call returns.\n\nstart returns JSON: scene, replaced, ran_again (the program ran again because the board or the stage changed since write_scene), length_s, starts_in_s and ends_in_s (seconds from now, pauses not counted), steps, items ([{id, kind, name, bounds, step}]), log, warnings, rerun (later scenes that ran again after a replace), and stage. With wait \"end\" it returns when the scene has played to its end, or earlier when playback stops at a pause, and adds played (true when it reached its end) and status. The other actions return the status after the action: {playing, scene, t, duration_s, step, paused, paused_by (\"pause step\", \"learner drawing\" or \"play_scene pause\"), paused_scene, paused_step, paused_t, queue: [{scene, duration_s}]}, with cancelled_programs, cut or replay where they apply.\n\nErrors: start without a draft of that name says so, and for a scene that has played it names \"replay\". If the draft runs again and now fails, nothing is drawn and the draft is kept.",
        inputSchema: {
          action: z.enum(PLAY_ACTIONS).describe('What to do; the description explains each action.'),
          name: z.string().min(1).max(MAX_NAME_CHARS).optional().describe('start, replay: the scene name. cut: act only when this scene plays.'),
          when: z.enum(['queue', 'now']).optional().describe('start, replay: "queue" (default) starts after the scenes that play or wait; "now" starts at once, over them.'),
          wait: z.enum(['start', 'end']).optional().describe('start: "start" (default) returns once the scene is queued; "end" returns when it (and every scene queued before it) has played to its end, or when playback stops at a pause before that.'),
          from_step: z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('replay: the step number or step name to play from. Without name, a step name finds the latest scene with that step.'),
          after_step: z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('cut: keep this step (number or name) of the playing scene, and drop what comes after it.')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
      },
      this.tool(session, 'play_scene', async ({ action, name, when, wait, from_step, after_step }, extra) => {
        const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args, SCENE_TIMEOUT_MS)) as Record<string, unknown>
        if (action === 'start') return this.startScene(session, extra, name, when ?? 'queue', wait ?? 'start')
        let cancelled = 0
        if (action === 'stop' || action === 'clear_queue' || action === 'cancel') cancelled = this.cancelPrograms(null)
        if (action === 'cancel') return text(json({ ...publicStatus(await control({ action: 'status' })), cancelled_programs: cancelled }))
        if (action === 'wait') return text(json(publicStatus(await control({ action: 'wait' }))))
        if (action === 'replay') {
          if (!name && from_step === undefined) return failure(new Error('replay needs name (a scene on the board), and from_step to start from a step.'))
          if (!name && typeof from_step === 'number') return failure(new Error('replay with a step number needs name; without name, from_step must be a step name.'))
          let sceneId: string | undefined
          if (name) {
            const entry = this.boardScene(name)
            if (!entry) return failure(this.unknownScene(name, 'board'))
            sceneId = entry.scene as string
          }
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
            return text(json({ ...publicStatus(status), cancelled_programs: cancelled }))
          }
          if (action === 'reset') {
            this.stage.reset('play_scene reset')
            return text(json({ ...publicStatus(await control({ action: 'resetStage', epoch: this.stage.epoch })), stage: 'new (play_scene reset)' }))
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
        this.stage.exclusive(async () => {
          const context = (await this.board('sceneContext', {})) as SceneContext
          this.stage.adopt(context)
          const reason = draftStale(draft, this.stage, context) ?? force ?? null
          if (!reason) return { rerun: null }
          const run = await this.stage.run(draft.code, context, { mode: 'draft', seed: draft.entry.seed, name: draft.name, signal })
          const liveError = await this.checkLivePrograms(livesOf(run.desc))
          if (signal.aborted) throw new SceneCancelled()
          if (liveError) throw liveError
          const next = await this.readyDraft(run, context, draft.name, draft.code, draft.seq)
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
    const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args, SCENE_TIMEOUT_MS)) as Record<string, unknown>
    try {
      return await this.withProgram(session, extra, (signal) =>
        this.stage.exclusive(async () => {
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
  private async startScene(session: Session, extra: ToolExtra, name: string | undefined, when: 'queue' | 'now', wait: 'start' | 'end'): Promise<CallToolResult> {
    if (!name) return failure(new Error('start needs name: the name of a draft from write_scene.'))
    const board = this.boardKey()
    const draft = this.draftsOf(board).get(name)
    if (!draft) {
      if (this.boardScene(name)) return failure(new Error(`No draft named "${name}": the scene "${name}" is on the board already and has no new version. replay plays it again; to change it, write_scene "${name}" first, then start.`))
      return failure(this.unknownScene(name, 'draft'))
    }
    const control = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => (await this.board('sceneControl', args, SCENE_TIMEOUT_MS)) as Record<string, unknown>
    let outcome: CallToolResult | { result: SceneResult & { ends_in_s: number }; rerun: string | null; replaced: boolean; others?: unknown[]; stage?: string }
    try {
      outcome = await this.withProgram(session, extra, (signal) =>
        this.stage.exclusive(async () => {
          const onBoard = this.boardScene(name)
          if (onBoard?.scene) {
            const sceneId = onBoard.scene
            const known = await control({ action: 'known', scene: sceneId })
            if (!known.known) {
              return failure(
                new Error(`The scene "${name}" on the board can no longer be replaced: the board's player no longer holds it (the window reloaded or the board was opened again). Nothing was drawn, and the draft is kept. Give the new version another name with write_scene, and remove the old items in its program if they must go.`)
              )
            }
            const status = await control({ action: 'status' })
            const out = await this.restage(sceneId, (status.waiting as string[]) ?? [], { code: draft.code, seed: draft.entry.seed, name, when }, signal)
            if ('content' in out) return out
            return { result: out.main, rerun: 'it replaces the scene on the board, so it ran at that scene\'s place on the stage', replaced: true, others: out.rerun }
          }
          const context = (await this.board('sceneContext', {})) as SceneContext
          this.stage.adopt(context)
          let reason = draftStale(draft, this.stage, context)
          /** Run the program again as a scene at the end of the stage, and commit it with its frames. */
          const runAndCommit = async (): Promise<{ result: SceneResult & { ends_in_s: number }; entry: StageEntry; fresh: string | null }> => {
            const run = await this.stage.run(draft.code, context, { mode: 'scene', seed: draft.entry.seed, name, signal })
            const liveError = await this.checkLivePrograms(livesOf(run.desc))
            if (signal.aborted || liveError) {
              this.stage.discard(run.entry)
              throw liveError ?? new SceneCancelled()
            }
            try {
              const result = (await this.board('runScene', { scene: run.desc, job: run.job, frames: run.frames, when, name }, SCENE_TIMEOUT_MS)) as SceneResult & { ends_in_s: number }
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
              out = await this.board('runScene', { draft: draftKey(draft.desc), when, name }, SCENE_TIMEOUT_MS)
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
      items: result.items,
      ...(result.log.length ? { log: result.log } : {}),
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      ...(outcome.others?.length ? { rerun: outcome.others } : {}),
      ...(outcome.stage ? { stage: outcome.stage } : {})
    }
    if (wait === 'end') {
      // Returns at the scene's end, or where playback stops at a pause before it (a pause step, the learner's drawing, play_scene pause).
      const status = await control({ action: 'waitPlayed', scene: result.scene })
      const { ended, ...rest } = status
      return text(json({ ...body, played: ended === true, status: publicStatus(rest) }))
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
