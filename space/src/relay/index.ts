/**
 * The Learning Space stdio relay: `~/.learning-space/bin/learning-space mcp`.
 *
 * An agent (Claude Code, Codex, the Claude app) starts this process and talks
 * MCP over stdin/stdout. The relay forwards every JSON-RPC message to the
 * running app's Streamable HTTP endpoint (http://127.0.0.1:<port>/mcp) and
 * every answer back. It never re-implements a tool.
 *
 * When the app is not running, the relay answers by itself: `initialize` with
 * the cached server instructions, `tools/list` from ~/.learning-space/tools.json,
 * and `tools/call` with a tool error that asks the agent to have the learner
 * open the app. Every later request tries the app again. When the app comes
 * up (or restarts), the relay opens a new upstream session with the client's
 * own initialize parameters, so the client session continues unchanged.
 *
 * It runs under Node (Electron's binary with ELECTRON_RUN_AS_NODE=1). stdout
 * carries protocol messages only; every log line goes to stderr.
 *
 * `learning-space news --client <label>` runs the same file for one request:
 * it prints the board news line (see printNews below) and exits.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId
} from '@modelcontextprotocol/sdk/types.js'

const SERVER_NAME = 'learning-space'
const DEFAULT_PORT = 47821
const HANDSHAKE_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 1500
const NOT_RUNNING_LINE = 'Learning Space is not running — ask the learner to open the app.'
const NOT_RUNNING_TOOL_ERROR = 'Learning Space is not running. Ask the learner to open the app, then try again.'

// Keep stdout for protocol messages only.
console.log = console.error
console.info = console.error
console.warn = console.error

function log(message: string): void {
  process.stderr.write(`learning-space relay: ${message}\n`)
}

/**
 * The reader of stdout went away (a client that stopped reading, `| head`): every later write fails
 * with EPIPE or ERR_STREAM_DESTROYED. Every write to stdout ends up here, whichever code made it, so
 * the process ends quietly with code 0. Other stdout errors stay uncaught, as before.
 */
let stdoutClosed = (): void => process.exit(0)
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error
  stdoutClosed()
})

const stateDir = join(homedir(), '.learning-space')

interface ToolsCache {
  tools: unknown[]
  instructions?: string
  appVersion?: string
}

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as T
  } catch {
    return null
  }
}

/** LEARNING_SPACE_PORT, else relay.json, else the default port. Read per connect, so a new app port is picked up. */
function endpoint(): URL {
  const valid = (value: unknown): number | null => {
    const port = Number(value)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  }
  const port = valid(process.env.LEARNING_SPACE_PORT) ?? valid(readJson<{ port?: number }>('relay.json')?.port) ?? DEFAULT_PORT
  return new URL(`http://127.0.0.1:${port}/mcp`)
}

function cache(): ToolsCache {
  const data = readJson<ToolsCache>('tools.json')
  return { tools: Array.isArray(data?.tools) ? data.tools : [], instructions: data?.instructions, appVersion: data?.appVersion }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** True when anything answers HTTP at the endpoint (the app answers a bare GET with 400). */
async function reachable(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

class Relay {
  private readonly client = new StdioServerTransport()
  private upstream: StreamableHTTPClientTransport | null = null
  private connecting: Promise<StreamableHTTPClientTransport | null> | null = null
  /** The client's initialize params, replayed for every new upstream session. */
  private initParams: JSONRPCRequest['params'] | null = null
  /** The relay answered initialize itself; tell the client to re-list tools once the app is up. */
  private answeredOffline = false
  /** Client requests sent upstream that wait for an answer: id → method. */
  private readonly pending = new Map<RequestId, string>()
  private handshakeCount = 0
  private closed = false
  /** stdout is closed: no answer can reach the client any more. */
  private clientGone = false
  /** Client messages still in progress (stdin can close before their answers are out). */
  private busy = 0

  async start(): Promise<void> {
    this.client.onmessage = (message) => {
      this.busy++
      void this.fromClient(message).finally(() => this.busy--)
    }
    this.client.onerror = (error) => log(`stdio error: ${error.message}`)
    this.client.onclose = () => void this.shutdown()
    process.stdin.on('end', () => void this.shutdown())
    process.stdin.on('close', () => void this.shutdown())
    process.on('SIGTERM', () => void this.shutdown())
    process.on('SIGINT', () => void this.shutdown())
    stdoutClosed = () => {
      this.clientGone = true
      void this.shutdown()
    }
    await this.client.start()
  }

  private async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Let answers to the last requests reach the client first (at most 10 s).
    const deadline = Date.now() + 10_000
    while (!this.clientGone && (this.busy > 0 || this.pending.size > 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    const upstream = this.upstream
    this.upstream = null
    if (upstream) {
      // End the app-side session, so the app stops listing this agent.
      await withTimeout(upstream.terminateSession(), 1000, 'session end').catch(() => undefined)
      await upstream.close().catch(() => undefined)
    }
    process.exit(0)
  }

  private reply(message: JSONRPCMessage): void {
    void this.client.send(message).catch((error: unknown) => log(`could not write to the client: ${String(error)}`))
  }

  // ---------- Client → app ----------

  private async fromClient(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(message)) {
      if (message.method === 'initialize') return this.initialize(message)
      if (message.method === 'ping') return this.reply({ jsonrpc: '2.0', id: message.id, result: {} })
      const upstream = await this.ensureUpstream()
      if (upstream && (await this.forward(upstream, message))) return
      this.offline(message)
      return
    }
    if (isJSONRPCNotification(message)) {
      // The relay sends its own notifications/initialized to each upstream session.
      if (message.method === 'notifications/initialized') return
      if (this.upstream) await this.upstream.send(message).catch(() => this.dropUpstream('a notification failed'))
      return
    }
    // A response to a request the app sent to the client (for example ping).
    if (this.upstream) await this.upstream.send(message).catch(() => this.dropUpstream('a response failed'))
  }

  private async initialize(request: JSONRPCRequest): Promise<void> {
    this.initParams = request.params ?? {}
    const upstream = await this.ensureUpstream(true)
    if (upstream && this.lastInitResult) {
      this.answeredOffline = false
      this.reply({ jsonrpc: '2.0', id: request.id, result: this.lastInitResult })
      return
    }
    this.answeredOffline = true
    const cached = cache()
    const requested = typeof this.initParams.protocolVersion === 'string' ? this.initParams.protocolVersion : ''
    const instructions = [cached.instructions?.trim(), NOT_RUNNING_LINE].filter(Boolean).join('\n\n')
    this.reply({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: cached.appVersion ?? '0.0.0' },
        instructions
      }
    })
  }

  /** Forward one request. False when the app is gone (the caller answers offline). */
  private async forward(upstream: StreamableHTTPClientTransport, request: JSONRPCRequest): Promise<boolean> {
    this.pending.set(request.id, request.method)
    try {
      await upstream.send(request)
      return true
    } catch (error) {
      this.pending.delete(request.id)
      this.dropUpstream(`send failed: ${error instanceof Error ? error.message : String(error)}`)
      // The app may have restarted (its old session is gone): try one fresh session.
      const fresh = await this.ensureUpstream()
      if (!fresh) return false
      this.pending.set(request.id, request.method)
      try {
        await fresh.send(request)
        return true
      } catch {
        this.pending.delete(request.id)
        this.dropUpstream('send failed on a fresh session')
        return false
      }
    }
  }

  /** The relay's own answer while the app is not running. */
  private offline(request: JSONRPCRequest): void {
    const id = request.id
    switch (request.method) {
      case 'tools/list':
        this.reply({ jsonrpc: '2.0', id, result: { tools: cache().tools } })
        return
      case 'tools/call':
        this.reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: NOT_RUNNING_TOOL_ERROR }], isError: true } })
        return
      case 'resources/list':
        this.reply({ jsonrpc: '2.0', id, result: { resources: [] } })
        return
      case 'prompts/list':
        this.reply({ jsonrpc: '2.0', id, result: { prompts: [] } })
        return
      default:
        this.reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `${request.method}: ${NOT_RUNNING_TOOL_ERROR}` } })
    }
  }

  // ---------- App → client ----------

  private fromUpstream(message: JSONRPCMessage): void {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const id = (message as { id?: RequestId }).id
      if (id !== undefined) this.pending.delete(id)
    }
    this.reply(message)
  }

  // ---------- Upstream session ----------

  private lastInitResult: Record<string, unknown> | null = null

  /** The live upstream, or a new one; null when the app is not reachable. One attempt at a time. */
  private ensureUpstream(force = false): Promise<StreamableHTTPClientTransport | null> {
    if (this.upstream && !force) return Promise.resolve(this.upstream)
    if (!this.initParams) return Promise.resolve(null)
    if (!this.connecting) {
      if (force && this.upstream) this.dropUpstream('re-initialize')
      this.connecting = this.connect()
        .catch((error: unknown) => {
          log(`app not reachable at ${endpoint().href}: ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        .finally(() => {
          this.connecting = null
        })
    }
    return this.connecting
  }

  private async connect(): Promise<StreamableHTTPClientTransport> {
    const url = endpoint()
    const transport = new StreamableHTTPClientTransport(url, { reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 500, maxReconnectionDelay: 2000, reconnectionDelayGrowFactor: 2 } })
    const initId = `learning-space-relay-init-${++this.handshakeCount}`
    let settle: ((message: JSONRPCMessage) => void) | null = null
    const answered = new Promise<JSONRPCMessage>((resolve) => {
      settle = resolve
    })
    transport.onmessage = (message) => {
      if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && (message as { id?: RequestId }).id === initId) settle?.(message)
    }
    transport.onerror = () => undefined
    try {
      await transport.start()
      await withTimeout(transport.send({ jsonrpc: '2.0', id: initId, method: 'initialize', params: this.initParams ?? {} }), HANDSHAKE_TIMEOUT_MS, 'initialize')
      const response = await withTimeout(answered, HANDSHAKE_TIMEOUT_MS, 'initialize answer')
      if (!isJSONRPCResultResponse(response)) throw new Error(`initialize refused: ${JSON.stringify(response)}`)
      const result = response.result as Record<string, unknown>
      if (typeof result.protocolVersion === 'string') transport.setProtocolVersion(result.protocolVersion)
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      this.lastInitResult = result
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw error
    }

    transport.onmessage = (message) => {
      if (this.upstream === transport) this.fromUpstream(message)
    }
    transport.onerror = (error) => {
      if (this.upstream !== transport) return
      log(`upstream: ${error.message}`)
      void this.checkUpstream(transport)
    }
    transport.onclose = () => {
      if (this.upstream === transport) this.dropUpstream('closed')
    }
    this.upstream = transport
    log(`connected to ${url.href} (session ${transport.sessionId ?? 'none'})`)
    if (this.answeredOffline) {
      // The client saw the offline answer: ask it to list the live tools.
      this.answeredOffline = false
      this.reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    return transport
  }

  /** After a transport error: when the app is gone, end the session and answer the waiting requests. */
  private async checkUpstream(transport: StreamableHTTPClientTransport): Promise<void> {
    if (await reachable(endpoint())) return
    if (this.upstream === transport) this.dropUpstream('the app stopped')
  }

  private dropUpstream(reason: string): void {
    const transport = this.upstream
    if (!transport) return
    this.upstream = null
    log(`upstream session ended (${reason})`)
    void transport.close().catch(() => undefined)
    // Requests the app will never answer get the offline answer.
    const waiting = [...this.pending.entries()]
    this.pending.clear()
    for (const [id, method] of waiting) this.offline({ jsonrpc: '2.0', id, method })
  }
}

const NEWS_TIMEOUT_MS = 1500

/**
 * `learning-space news --client <label>`: print the board news line for that
 * agent app ("Codex", "Claude Code"; see main/news.ts), for a hook that runs
 * before each prompt. It prints nothing when nothing is new, when the app is
 * closed, or on any error, and always exits 0.
 */
async function printNews(args: string[]): Promise<void> {
  const at = args.indexOf('--client')
  const client = at >= 0 ? (args[at + 1] ?? '').trim() : ''
  if (!client) return
  try {
    const url = endpoint()
    url.pathname = '/news'
    url.searchParams.set('client', client)
    const response = await fetch(url, { signal: AbortSignal.timeout(NEWS_TIMEOUT_MS) })
    if (!response.ok) return
    const line = (await response.text()).trim()
    if (line) process.stdout.write(`${line}\n`)
  } catch {
    // The app is closed or busy: no news.
  }
}

if (process.argv[2] === 'news') {
  void printNews(process.argv.slice(3)).finally(() => process.exit(0))
} else {
  void new Relay().start().catch((error: unknown) => {
    log(`could not start: ${String(error)}`)
    process.exit(1)
  })
}
