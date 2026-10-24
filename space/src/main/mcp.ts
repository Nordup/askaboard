import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, ipcMain, type WebContents } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  MAX_BOX_SIZE,
  MAX_COORD,
  MAX_HTML_CHARS,
  MAX_INK_LINES,
  MAX_INK_POINTS,
  MAX_LIST_ITEMS,
  MAX_NAME_CHARS,
  MAX_REGION_SIZE,
  MAX_STYLE_CHARS,
  MAX_SVG_PATH_CHARS,
  MAX_TEXT_CHARS
} from '@shared/limits'
import { guideText, guideTopics, serverInstructions } from './guide'
import type { SnapshotRenderer } from './snapshot'
import { LearnerEditLog, SessionTrace, writeLearnerEdit } from './trace'
import {
  IPC,
  type AgentActivity,
  type AgentRef,
  type AgentToolName,
  type AgentMethod,
  type AgentMethods,
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
 */

export const DEFAULT_MCP_PORT = 47821
const BRIDGE_TIMEOUT_MS = 10_000
/** Writes can download images first. */
const WRITE_TIMEOUT_MS = 45_000
const MAX_BODY_BYTES = 4 * 1024 * 1024
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
   * get_screenshot("changes") shows the ink that get_changes listed.
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
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

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
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Learning Space did not answer "${method}" within ${timeoutMs / 1000} s. The window may be loading or busy.`))
      }, timeoutMs)
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

/** A readable name for an MCP client, for the presence label. */
function clientLabel(raw: string | undefined): string {
  const name = (raw ?? '').toLowerCase()
  if (name.includes('claude')) return 'Claude Code'
  if (name.includes('codex')) return 'Codex'
  if (name.includes('cursor')) return 'Cursor'
  return raw && raw.length <= 24 ? raw : 'Agent'
}

const nodeIds = z.array(z.string()).min(1).max(MAX_LIST_ITEMS, `At most ${MAX_LIST_ITEMS} ids per call.`)

/** A board coordinate or offset (z.number() already refuses NaN and Infinity). */
const coord = (): z.ZodNumber =>
  z.number().min(-MAX_COORD, `Coordinates must be within ±${MAX_COORD} board points.`).max(MAX_COORD, `Coordinates must be within ±${MAX_COORD} board points.`)
/** A width or height in board points. */
const boxSize = (max: number): z.ZodNumber => z.number().positive().max(max, `Sizes must be at most ${max} board points.`)
/** A style object: camelCase CSS, numbers mean px. */
const styleValue = z.union([z.string().max(MAX_STYLE_CHARS, `Style values must be at most ${MAX_STYLE_CHARS} characters.`), coord()])

const rectSchema = z.object({
  x: coord().describe('Left edge, board points'),
  y: coord().describe('Top edge, board points'),
  width: boxSize(MAX_REGION_SIZE),
  height: boxSize(MAX_REGION_SIZE)
})

const placeSchema = z
  .object({
    right_of: z.string().optional(),
    left_of: z.string().optional(),
    below: z.string().optional(),
    above: z.string().optional(),
    over: z.string().optional().describe('On top of the target, centred (for marks on the learner\'s work).'),
    gap: coord().optional().describe('Distance to the target in board points (default 32; 0 for over).'),
    align: z.enum(['start', 'center', 'end']).optional().describe('Alignment along the side (default "start"; "center" for over).')
  })
  .describe(
    'Place relative to a node or ink group: exactly one of right_of, left_of, below, above, over with its id. If the spot is taken it slides along that side, then tries the next side; the result says where it went.'
  )

// ---------- The server ----------

export class AgentServer {
  readonly port = configuredPort()
  private readonly bridge: RendererBridge
  private readonly sessions = new Map<string, Session>()
  private http: Server | null = null
  private state: AgentServerStatus['state'] = 'starting'
  private error: string | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private publishTimer: NodeJS.Timeout | null = null
  private lastPublish = 0
  private readonly learnerEdits = new LearnerEditLog()

  constructor(private readonly hooks: AgentServerHooks) {
    this.bridge = new RendererBridge(hooks.webContents)
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

  /** The renderer read a board (sets the baseline for learner edits). */
  boardRead(board: string, text: string): void {
    const folder = this.hooks.folderRoot()
    if (folder) this.learnerEdits.read(folder, board, text)
  }

  /**
   * The renderer saved a board: log the learner's new or changed nodes, if any, to the day's
   * learner-edits.jsonl only (trace-report joins them to sessions by board and time). Never throws.
   */
  boardSaved(board: string, text: string): void {
    try {
      const folder = this.hooks.folderRoot()
      const edit = folder ? this.learnerEdits.saved(folder, board, text) : null
      if (edit) writeLearnerEdit(edit)
    } catch (error) {
      console.warn(`trace: learner edit not recorded: ${String(error)}`)
    }
  }

  /** Wrap a tool body: activity pulse, logging, errors as tool errors, the session trace. */
  private tool<A>(session: Session, name: string, body: (args: A) => Promise<CallToolResult>) {
    return async (args: A): Promise<CallToolResult> => {
      session.lastActivity = Date.now()
      this.hooks.activity({ sessionId: session.id, tool: name })
      const start = Date.now()
      let result: CallToolResult
      let thrown: unknown = null
      try {
        result = await body(args)
      } catch (error) {
        console.warn(`mcp: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
        thrown = error
        result = failure(error)
      }
      this.traceOf(session)?.call(name, args, start, Date.now(), this.hooks.shownBoard(), thrown === null ? result : null, thrown)
      return result
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
    if (current === undefined) session.cursors.set(path, info.cursor)
    else if (current > info.cursor) {
      console.warn(`mcp: ${path} seq went back from ${current} to ${info.cursor}; resetting the cursor`)
      session.cursors.set(path, info.cursor)
      session.listedFrom.delete(path)
    }
  }

  /** Run a board tool in the renderer, as this session. */
  private board(session: Session, tool: AgentToolName, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const agent: AgentRef = { sessionId: session.id, client: clientLabel(session.server.server.getClientVersion()?.name) }
    return this.bridge.request('agentTool', { tool, args, agent }, timeoutMs)
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
          "Describe the current state of Learning Space: the learning folder (name and absolute path), the open board and all boards in the folder, the learner's visible viewport and the bounds of all content (board rects), node counts by kind, the top-level nodes (id, kind, name, author, bounds), the ink groups (id such as \"g3\", author, parent, stroke count, bounds), the learner's selection (ids and bounds), the learner's current tool, and your change cursor. Use it to orient yourself on a board and to find ids and free areas. It returns structured data, not an image: to see what is written or drawn, use get_screenshot. Coordinates are board points (origin at the centre, +x right, +y down).",
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
          "Render part of the open board to a PNG image, the same way the learner sees it (ink, text, math, drawings, images; no app interface). It works for any area, also outside the learner's view. Choose what to capture with node_id (one node or ink group, with a small margin), region (an exact board rect), or target: \"viewport\" (what the learner sees now; the default), \"content\" (the whole board), \"selection\" (what the learner selected), or \"changes\" (only what is new since your last \"changes\" screenshot: new items in dashed blue boxes, erased items in dashed pink boxes; this moves your change cursor). labels: true adds id tags and outlines, and grid: true adds board coordinates every 100 points; both appear only in your image. The text part of the result gives the board rect the image covers and the pixel-to-board conversion. Large areas at a high scale make large images; a node_id or a small region gives a sharper view of handwriting.",
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
          if (session.cursors.has(info.board?.path ?? '')) this.touchCursor(session, info)
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
          session.cursors.set(plan.board, plan.cursor)
        }
        if (plan.kind === 'empty') return text(plan.message)
        const shot = await this.hooks.snapshots.capture({
          nodes: plan.nodes,
          rect: plan.rect,
          scale: plan.scale,
          width: plan.width,
          height: plan.height,
          outlines: plan.outlines,
          overlays: plan.overlays,
          background: plan.background
        })
        const what = node_id ? `node ${node_id}` : `target "${kind}"`
        const lines = [
          `Board "${plan.board}", ${what}.`,
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
          "List what changed on the open board since your change cursor: items added or changed (id, kind, tool, colour, author of the change, bounds, seq), items removed (id, bounds, seq), the ink groups that hold changed strokes (groups_changed), and your new cursor. It returns data, not an image; use get_screenshot with target \"changes\" or a node_id to see the items. Your cursor starts at your first look at a board (get_canvas_info, get_changes, get_screenshot or open_board), so the first call lists nothing new; since: 0 lists the whole history of the board. The list includes your own writes; the author field tells them apart from the learner's.",
        inputSchema: {
          since: z.number().int().min(0).optional().describe("A cursor value to compare against instead of your own cursor; 0 means everything on the board.")
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_changes', async ({ since }) => {
        // since: 0 means "everything": -1 also catches items from files that carry no seq (seq 0).
        let from: number | null = since === undefined ? null : since === 0 ? -1 : since
        if (from === null) {
          const info = await this.bridge.request('canvasInfo', {})
          if (session.cursors.has(info.board?.path ?? '')) this.touchCursor(session, info)
          from = info.board ? (session.cursors.get(info.board.path) ?? null) : null
        }
        const changes = await this.bridge.request('changes', { since: from })
        if (from !== null && !session.listedFrom.has(changes.board)) session.listedFrom.set(changes.board, from)
        session.cursors.set(changes.board, changes.cursor)
        return text(json(changes))
      })
    )

    server.registerTool(
      'open_board',
      {
        title: 'Open a board',
        description:
          "Open another board of the learning folder in the app, so that the learner and you both see it. The learner's view switches to it. path is relative to the learning folder and ends in .board.json (the boards are listed in get_canvas_info). Returns the canvas info of the opened board.",
        inputSchema: { path: z.string().describe('For example "boards/Fractions.board.json".') }
      },
      this.tool(session, 'open_board', async ({ path }) => {
        const info = await this.bridge.request('openBoard', { path })
        this.touchCursor(session, info)
        return text(this.infoText(info))
      })
    )

    server.registerTool(
      'get_guide',
      {
        title: 'The agent guide',
        description:
          `Read the Learning Space guide. Topic "brief" explains what the space is for and how the person and you work together in it; it is the same text as the brief in a learning folder's AGENTS.md, so skip it when that is already in your context. The reference topics describe the board's model and the details of every write: html, math, svg, images, tokens, placement, ink and view. topic: one of ${guideTopics(this.hooks.folderRoot()).join(', ')}. Without a topic, one call returns every reference topic (about 7,000 characters). The learning folder's own guidance, if any, comes last.`,
        inputSchema: { topic: z.string().optional() },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_guide', async ({ topic }) => text(guideText(this.hooks.folderRoot(), topic)))
    )

    server.registerTool(
      'get_tree',
      {
        title: 'Node tree',
        description:
          "A compact text outline of the open board, or of one node and its children: one line per node with kind, name, id and bounds (\"x,y w×h\"); text nodes show their first words, and ink shows as ink groups with author and stroke count under their parent. Use it to find ids and to see how material is grouped; it is much smaller than a screenshot and shows no pixels. depth sets how many levels inside frames it lists (default 3).",
        inputSchema: { node_id: z.string().optional(), depth: z.number().int().min(1).max(10).optional() },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_tree', async (args) => text(String(await this.board(session, 'getTree', args))))
    )

    server.registerTool(
      'get_node_info',
      {
        title: 'Node details',
        description:
          "Every stored detail of one node or ink group: kind, name, author, parent, children ids, bounds on the board and inside the parent, z order, style, text with markup, SVG element ids, image source, or for ink the tool, colour, width and point count. For an ink group id it lists the group's strokes and bounds. Use it when you need exact values before you change a node.",
        inputSchema: { node_id: z.string() },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_node_info', async (args) => text(json(await this.board(session, 'getNodeInfo', args))))
    )

    server.registerTool(
      'get_html',
      {
        title: 'Node as HTML',
        description:
          "A node and everything inside it as the HTML subset that write_html accepts, with inline styles; include_ids adds data-id attributes. Use it to restructure existing material: edit the HTML and write it back with write_html mode \"replace\", and nodes whose data-id you keep keep their ids. Ink is not HTML: it appears as a comment and stays in place on replace.",
        inputSchema: { node_id: z.string(), include_ids: z.boolean().optional() },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'get_html', async (args) => text(String(await this.board(session, 'getHtml', args))))
    )

    server.registerTool(
      'create_frame',
      {
        title: 'Create a frame',
        description:
          "Create an empty top-level frame: a box that holds other nodes and moves with them, such as a page of reading, a worked example or a set of exercises. Fill it afterwards with write_html (target_id = the frame's id). Default style: a 480 px wide flex column with padding, a gap, a card background and rounded corners; style overrides any of it. Position: place (relative to a node or ink group), or x and y, or neither, in which case the app picks an empty spot beside near, else beside the learner's latest handwriting, else in the middle of their view. Returns the id, the bounds, how it was placed, whether it is in the learner's view, and what it overlaps.",
        inputSchema: {
          name: z.string().max(MAX_NAME_CHARS).optional(),
          style: z.record(z.string(), styleValue).optional().describe('camelCase CSS, overrides the defaults.'),
          x: coord().optional(),
          y: coord().optional(),
          near: z.string().optional().describe('A node or ink group id to place the frame beside (automatic spot).'),
          place: placeSchema.optional()
        }
      },
      this.tool(session, 'create_frame', async (args) => text(json(await this.board(session, 'createFrame', args, WRITE_TIMEOUT_MS))))
    )

    server.registerTool(
      'write_html',
      {
        title: 'Write HTML as nodes',
        description:
          "Add material to the board as nodes, written in a small HTML subset: text and formulas (<p>, <h1>–<h6>, <b>, <i>, $math$), SVG drawings (<svg>), images (<img>), and boxes (<div>, which become frames). mode \"insert_children\" (default) adds the HTML inside the frame target_id, or at the top level for target_id \"root\"; mode \"replace\" replaces the node target_id, and the first new top-level node keeps target_id's id. For \"root\", place puts the new nodes relative to a node or ink group, and near picks an automatic spot beside one. Returns the new top-level ids, a map from layer-name to id, the measured bounds after layout, whether everything is in the learner's view, what the new nodes overlap, and any HTML or styles that were ignored. The supported tags and styles are in get_guide topic \"html\". One undo step for the learner.",
        inputSchema: {
          html: z.string().max(MAX_HTML_CHARS, `html must be at most ${MAX_HTML_CHARS} characters; write it in smaller parts.`),
          target_id: z.string().describe('A frame id, or "root".'),
          mode: z.enum(['insert_children', 'replace']).optional(),
          near: z.string().optional().describe('target_id "root" only: a node or ink group id for the automatic spot.'),
          place: placeSchema.optional().describe('target_id "root" only: place the new nodes relative to a node or ink group.')
        }
      },
      this.tool(session, 'write_html', async (args) => text(json(await this.board(session, 'writeHtml', args, WRITE_TIMEOUT_MS))))
    )

    server.registerTool(
      'update_styles',
      {
        title: 'Update styles',
        description:
          "Change style properties of existing nodes, such as colour, size, padding, border or font. updates is a list of {node_ids, styles}; styles are camelCase CSS, numbers mean px, and \"\" or null removes a property. Ink nodes and ink groups accept only color. Positions are not styles: use move_nodes. Returns the properties that were ignored and what the nodes now overlap. One undo step for the learner.",
        inputSchema: {
          updates: z.array(z.object({ node_ids: nodeIds, styles: z.record(z.string(), z.union([styleValue, z.null()])) })).min(1).max(MAX_LIST_ITEMS)
        }
      },
      this.tool(session, 'update_styles', async (args) => text(json(await this.board(session, 'updateStyles', args))))
    )

    server.registerTool(
      'set_text',
      {
        title: 'Set text',
        description:
          "Replace the text of existing text nodes and keep their ids, styles and places. updates is a list of {node_id, text}; text uses the markup **bold**, *italic* and $math$ (write a literal * or $ as \\* or \\$). One undo step for the learner.",
        inputSchema: {
          updates: z
            .array(z.object({ node_id: z.string(), text: z.string().max(MAX_TEXT_CHARS, `text must be at most ${MAX_TEXT_CHARS} characters.`) }))
            .min(1)
            .max(MAX_LIST_ITEMS)
        }
      },
      this.tool(session, 'set_text', async (args) => text(json(await this.board(session, 'setText', args))))
    )

    server.registerTool(
      'move_nodes',
      {
        title: 'Move nodes',
        description:
          "Move or reorder nodes and ink groups; moving a group moves all its strokes, and learner ink can be moved too. Each move is one of: {node_id, place} (relative to another node or group), {node_id, x, y} (top-left in the parent's space, board space at the top level), {node_id, dx, dy}, {node_id, parent_id, index?} (into another frame, or \"root\"; the position on the board stays), or {node_id, before | after: sibling_id}. Children of a flex frame are reordered, not placed. Returns the new bounds and what each moved item now overlaps. One undo step for the learner.",
        inputSchema: {
          moves: z
            .array(
              z.object({
                node_id: z.string(),
                x: coord().optional(),
                y: coord().optional(),
                dx: coord().optional(),
                dy: coord().optional(),
                parent_id: z.string().optional(),
                index: z.number().int().min(0).optional(),
                before: z.string().optional(),
                after: z.string().optional(),
                place: placeSchema.optional()
              })
            )
            .min(1)
            .max(MAX_LIST_ITEMS)
        }
      },
      this.tool(session, 'move_nodes', async (args) => text(json(await this.board(session, 'moveNodes', args))))
    )

    server.registerTool(
      'duplicate_nodes',
      {
        title: 'Duplicate nodes',
        description:
          "Copy nodes (with everything inside them) or ink groups. A top-level copy goes to empty space beside its original, or where place says; a copy inside a flex frame goes right after its original. Returns a map from each original id to its copy, children included, whether the copies are in the learner's view, and what they overlap. One undo step for the learner.",
        inputSchema: { node_ids: nodeIds, place: placeSchema.optional() }
      },
      this.tool(session, 'duplicate_nodes', async (args) => text(json(await this.board(session, 'duplicateNodes', args))))
    )

    server.registerTool(
      'delete_nodes',
      {
        title: 'Delete nodes',
        description:
          "Delete nodes with everything inside them, or ink groups with all their strokes. This works on any node, including the learner's own ink. Returns what was removed. The learner can undo it. Ids are node ids or ink group ids (g1, g2, …) from get_canvas_info or get_tree.",
        inputSchema: { node_ids: nodeIds }
      },
      this.tool(session, 'delete_nodes', async (args) => text(json(await this.board(session, 'deleteNodes', args))))
    )

    server.registerTool(
      'draw_ink',
      {
        title: 'Draw ink',
        description:
          "Draw pen strokes on the board: the same kind of ink as the learner's handwriting, with natural pressure and a slight hand wobble, which the learner can erase, lasso or move like their own. Give one of: shape + target (circle, underline, tick, cross or arrow, built from the bounds of a node or ink group; an arrow starts at from_id or comes in from side), strokes (lists of [x, y] points), or svg_path (an SVG path \"d\" with M, L, C, Q, A, Z; each subpath becomes one stroke). Coordinates in strokes and svg_path are board points, or relative to x, y when given, or placed as a whole with place. Ink drawn over a frame becomes part of it. Ink cannot fill shapes and is not suited to words; use write_html for text and filled drawings. Each call makes one ink group and one undo step. Default colour: pink for circle and cross, green for tick, otherwise the accent, never the learner's pen colour. Returns the group id, its bounds and what it overlaps.",
        inputSchema: {
          shape: z.enum(['circle', 'underline', 'tick', 'cross', 'arrow']).optional(),
          target: z.string().optional().describe('shape: the node or ink group to mark.'),
          from_id: z.string().optional().describe('arrow: start at this node or group.'),
          side: z.enum(['left', 'right', 'above', 'below']).optional().describe('arrow without from_id: come in from this side (default left).'),
          strokes: z
            .array(z.array(z.array(coord()).min(2).max(3)).min(1).max(MAX_INK_POINTS, `At most ${MAX_INK_POINTS} points.`))
            .max(MAX_INK_LINES, `At most ${MAX_INK_LINES} strokes.`)
            .optional()
            .describe('Polylines of [x, y] points.'),
          svg_path: z
            .string()
            .max(MAX_SVG_PATH_CHARS, `svg_path must be at most ${MAX_SVG_PATH_CHARS} characters.`)
            .optional()
            .describe('An SVG path "d" (M, L, C, Q, A, Z …); each subpath is one stroke.'),
          x: coord().optional(),
          y: coord().optional(),
          place: placeSchema.optional(),
          parent_id: z.string().optional().describe('A frame to hold the ink, or "root". Default: the frame under most of it.'),
          color: z.string().optional().describe('Hex, rgb(), or a name: accent, good, bad, warn, white, yellow, blue, green, pink, orange.'),
          width: z.number().positive().max(40).optional().describe('Pen width in board points (default 3.5; the highlighter is 4 times wider).'),
          tool: z.enum(['pen', 'highlighter']).optional(),
          jitter: z.number().min(0).max(1).optional().describe('Hand wobble, 0 = none (default 0.3).')
        }
      },
      this.tool(session, 'draw_ink', async (args) => text(json(await this.board(session, 'drawInk', args))))
    )

    server.registerTool(
      'find_space',
      {
        title: 'Find empty space',
        description:
          "Find an empty rect of a given size on the open board: no overlap with any top-level node or ink, with a 32-point margin, nearest to near (a node or ink group) or to the centre of the learner's view. inside_view (default true) prefers spots fully inside the learner's view. Returns {x, y, width, height, visible}. Use it before a write that takes x and y; writes with place or near find their own space.",
        inputSchema: {
          width: boxSize(MAX_BOX_SIZE),
          height: boxSize(MAX_BOX_SIZE),
          near: z.string().optional(),
          inside_view: z.boolean().optional()
        },
        annotations: { readOnlyHint: true }
      },
      this.tool(session, 'find_space', async (args) => text(json(await this.board(session, 'findSpace', args))))
    )

    server.registerTool(
      'focus',
      {
        title: "Move the learner's view",
        description:
          "Move the learner's view to a node, ink group or region, with a short glide; it zooms out only when the target does not fit, or to zoom when given. It does nothing when the target is already fully in view, and it is skipped while the learner is writing (a stroke in progress or one in the last 2 seconds). Returns the new viewport, or that it was skipped and why.",
        inputSchema: {
          node_id: z.string().optional(),
          region: rectSchema.optional(),
          padding: z.number().min(0).max(MAX_COORD).optional().describe('Board points around the target (default 48).'),
          zoom: z.number().positive().max(100).optional()
        }
      },
      this.tool(session, 'focus', async (args) => text(json(await this.board(session, 'focus', args))))
    )

    server.registerTool(
      'finish_working',
      {
        title: 'Finish working',
        description:
          "Remove the \"agent working\" outline that the learner sees around the top-level nodes you are changing: for node_ids, or for all of yours when node_ids is omitted. Outlines also fade 20 seconds after your last write.",
        inputSchema: { node_ids: z.array(z.string()).max(MAX_LIST_ITEMS).optional() }
      },
      this.tool(session, 'finish_working', async (args) => text(json(await this.board(session, 'finishWorking', args))))
    )
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
        reject(new BodyTooLarge(`The request is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB. Send less per call (write_html takes at most ${MAX_HTML_CHARS} characters).`))
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
