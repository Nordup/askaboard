import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ipcMain, type WebContents } from 'electron'
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

const IDS_NOTE = 'Ids: node ids, or ink group ids (g1, g2, …) from get_canvas_info / get_tree.'

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

  // ---------- Sessions ----------

  private createSession(): Session {
    const server = new McpServer({ name: 'learning-space', version: '0.0.1' }, { instructions: serverInstructions(this.hooks.folderRoot()) })
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
      console.log(`mcp: session ${session.id} (${server.server.getClientVersion()?.name ?? 'agent'}) closed`)
      this.publish()
    }
    server.server.oninitialized = () => {
      console.log(`mcp: session ${session.id} is ${server.server.getClientVersion()?.name ?? 'an unnamed client'}`)
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

  /** Wrap a tool body: activity pulse, logging, errors as tool errors. */
  private tool<A>(session: Session, name: string, body: (args: A) => Promise<CallToolResult>) {
    return async (args: A): Promise<CallToolResult> => {
      session.lastActivity = Date.now()
      this.hooks.activity({ sessionId: session.id, tool: name })
      try {
        return await body(args)
      } catch (error) {
        console.warn(`mcp: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
        return failure(error)
      }
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
          "Describe the learner's canvas: the learning folder (name, absolute path), the open board (relative path, name), " +
          'all boards in the folder, the visible viewport and the bounds of all content as board-coordinate rects, node counts by kind, ' +
          'the top-level nodes (id, kind, name, author, bounds), the ink groups (inkGroups: id like "g3", author, parent, stroke count, bounds), ' +
          "the learner's selection (ids and bounds), the current tool, and the change cursor. " +
          COORDINATES_NOTE,
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
          'Render part of the open board to a PNG: content (frames, text, math, SVG, images) and ink together, on the canvas background, without app UI. ' +
          'Works for any area, also off screen. Give node_id for one node (with a small margin), region for an exact board rect, or target: ' +
          '"viewport" (what the learner sees now), "content" (everything), "selection" (what the learner selected), "changes" (only what is new since your last look, ' +
          'each new item in a dashed blue box and erased items in dashed pink boxes; it advances your change cursor). The default is "viewport". ' +
          'The text part says which board rect the image covers and its scale. ' +
          'labels: true draws id tags (ink groups g1…, top-level node ids) with thin outlines; grid: true draws board-coordinate lines every 100 pt with numbers on the edges. Both are only in your image. ' +
          COORDINATES_NOTE,
        inputSchema: {
          node_id: z.string().optional().describe('Capture this node (frame, text, svg, image or ink) or ink group ("g3").'),
          region: rectSchema.optional().describe('Capture this board rect.'),
          target: z.enum(['viewport', 'content', 'selection', 'changes', 'region']).optional().describe('What to capture when there is no node_id or region.'),
          scale: z.number().positive().max(4).optional().describe('Image pixels per board point (default 1). Lowered when the image would exceed max_size.'),
          max_size: z.number().int().min(256).max(4096).optional().describe('The longest image side in pixels (default 1600).'),
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
          maxSize: max_size ?? 1600,
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
          'List what changed on the open board since your change cursor: items added or changed (id, kind, tool, colour, bounds, seq) and items removed (id, bounds, seq), ' +
          'plus the new cursor. Changes are those with seq > since; the cursor is the highest seq seen, so passing it back as since never repeats an item. ' +
          'Advances your cursor. Your cursor starts at your first call to any tool, so the first call returns nothing new; pass since: 0 for the whole history. ' +
          'groups_changed lists the ink groups (g1, g2, …) that hold changed strokes: refer to the learner\'s work by these ids. ' +
          'Then call get_screenshot with target "changes" to SEE that ink: it shows everything listed by get_changes since your last "changes" screenshot. ' +
          COORDINATES_NOTE,
        inputSchema: {
          since: z.number().int().min(0).optional().describe('A cursor value to diff from instead of your own cursor. 0 = everything on the board.')
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
          'Open another board in the app, so the learner and you both see it. `path` is relative to the learning folder and ends in .board.json (see "boards" in get_canvas_info). Returns the canvas info.',
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
        description: `How to write material on the board: the HTML subset, text markup and math, SVG, images, colour tokens, placement and the workflow. Read it once before your first write. topic: one of ${guideTopics(this.hooks.folderRoot()).join(', ')}; omit for all (the learning folder's own guidance comes last).`,
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
          'A compact outline of the board (or of one node): one line per node with kind, name, id and world bounds "x,y w×h"; text shows its first words; ink shows as ink groups ("ink group g3 … 5 strokes (learner)") under their parent. ' +
          'Cheap: use it to orient yourself and to find ids. depth limits how far into frames it goes (default 3).',
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
          'Everything about one node: kind, name, author, parent, children ids, world bounds, position inside the parent, z, style, text (markup), svg element ids, image src, or ink tool/colour/width/point count. For an ink group id: its strokes and bounds.',
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
          'A node and its subtree as the same HTML subset write_html takes (inline styles, data-id on every element when include_ids is true). Edit it and write it back with write_html mode "replace": ids in data-id are kept. Ink is not HTML: it shows as a comment and is kept on replace.',
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
          'Make a new top-level frame (a card) to write into. Default style: flex column, gap 12px, padding 24px, width 480px, height fit-content, card background, rounded corners. ' +
          'Position: place (relative to a node or ink group), or x and y, or neither: then the best empty spot beside `near` if given, else beside the learner\'s latest handwriting, else at the view centre, never over nodes or ink. Spots inside the learner\'s view come first; visible: false says it is outside. Returns the id, bounds, how it was placed and overlaps.',
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
          'Convert HTML (inline styles, flex, text with <b>/<i>/$math$, <svg>, <img>) into board nodes. mode "insert_children" (default) appends into the frame target_id ("root" = top level, auto-placed); ' +
          'mode "replace" replaces the node target_id with the HTML. With target_id "root", place puts the new top-level nodes relative to a node or ink group. Returns the created top-level ids, a layer-name → id map, their measured bounds after layout, overlaps, and what was ignored. Call get_guide first for the subset. One undo step.',
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
          'Set style keys on nodes: updates is a list of {node_ids, styles}; styles are camelCase CSS (numbers mean px; "" or null removes a key). Ink and ink groups take color only. Positions are not styles: use move_nodes. Returns ignored_styles and overlaps. One undo step.',
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
        description: 'Replace the text of text nodes: updates is a list of {node_id, text}. text uses the markup **bold**, *italic*, $math$. One undo step.',
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
          'Move or reorder nodes and ink groups (a group moves all its strokes), learner ink included. Each move is one of: {node_id, place} (relative to another node or group), {node_id, x, y} (the top-left in the parent\'s space; board space at top level), {node_id, dx, dy}, ' +
          '{node_id, parent_id, index?} (into another frame, or "root"; keeps the world position), {node_id, before: sibling_id} or {node_id, after: sibling_id}. Children of flex frames are reordered, not placed. Returns the new bounds and overlaps (what each moved item now covers). One undo step.',
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
          'Copy nodes (with their subtrees) or ink groups. A top-level copy goes to empty space beside its original (or by place), inside the learner\'s view when it fits (else listed in outside_view); a copy inside a flex frame comes right after its original. Returns original → copy ids, including descendants, and overlaps. One undo step.',
        inputSchema: { node_ids: nodeIds, place: placeSchema.optional() }
      },
      this.tool(session, 'duplicate_nodes', async (args) => text(json(await this.board(session, 'duplicateNodes', args))))
    )

    server.registerTool(
      'delete_nodes',
      {
        title: 'Delete nodes',
        description: `Delete nodes and everything inside them, or ink groups (all their strokes); learner ink only when that is what the learner wants. Returns what was removed. The learner can undo it. ${IDS_NOTE}`,
        inputSchema: { node_ids: nodeIds }
      },
      this.tool(session, 'delete_nodes', async (args) => text(json(await this.board(session, 'deleteNodes', args))))
    )

    server.registerTool(
      'draw_ink',
      {
        title: 'Draw ink',
        description:
          'Draw by hand on the board: marks on the learner\'s work (circle a mistake, tick, cross, underline, arrow) or sketches. The ink gets a natural pen pressure and a slight wobble. ' +
          'Give one of: shape + target (circle | underline | tick | cross | arrow, built from the target\'s bounds; arrow from from_id or from side), strokes ([[[x,y],…],…]), or svg_path (one path "d"). ' +
          'strokes and svg_path are board coordinates; with x, y they are relative to (x, y); with place their bounds are placed relative to a node or ink group (place {over: "g3"} centres them on it). ' +
          'Default colour: pink for circle/cross, green for tick, else the accent, never the learner\'s pen colour. Ink over a frame joins the frame. Returns the new group id, bounds and overlaps. One undo step.',
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
          'An empty rect of the given size: no overlap with any top-level node or ink, with a 32 pt margin, nearest to `near` (a node or ink group) or to the centre of the learner\'s view. ' +
          'inside_view (default true) prefers spots fully inside the learner\'s view. Returns {x, y, width, height, visible}. Use it before x, y writes.',
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
          "Glide the learner's view to a node, ink group or region; it zooms out only when the target does not fit (or to `zoom` if given). Use sparingly, for something the learner must see now. " +
          'It does nothing when the target is already in view, and it is skipped while the learner writes (a stroke in progress or one in the last 2 s). Returns the new viewport, or skipped with the reason.',
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
          'Say you are done with some material: removes your "working" outline from those top-level nodes (all of yours when node_ids is omitted). Outlines also fade 20 s after your last write.',
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
