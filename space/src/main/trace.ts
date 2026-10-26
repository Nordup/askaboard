import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { LearnerEditDelta } from '@shared/learner-edit'
import { agentHomeDir } from './agent-home'

/**
 * The session trace: every MCP tool call, one JSONL file per MCP session, for
 * measuring how agents use the board (bench runs and real sessions alike).
 *
 *   <root>/<YYYY-MM-DD>/<HHMMSS>-<client>-<shortSessionId>.jsonl
 *   <root>/<YYYY-MM-DD>/<HHMMSS>-<client>-<shortSessionId>-<n>.png   screenshots the agent received
 *   <root>/<YYYY-MM-DD>/learner-edits.jsonl                          learner edits, for all sessions and boards
 *
 * The root is ~/.learning-space/traces, or $SPACE_TRACE_DIR. Events (one JSON
 * object per line, `type` first):
 *
 *   session_open   t, session_id, client {name, version}, folder, board
 *   tool_call      t (start), end, duration_ms, gap_ms, board, tool, args, ok,
 *                  result_text, images [{file, bytes}], error
 *   session_close  t, session_id, calls, wall_ms
 *
 * and in learner-edits.jsonl only:
 *
 *   learner_edit   t, folder, board, ids, strokes, bounds
 *
 * session_open's board is the board shown when the client connected; the
 * person can switch boards later, so each tool_call names the board shown when
 * the call ended (for open_board, the board it opened). A session's learner
 * edits are not copied into its file: trace-report joins learner-edits.jsonl to
 * a session by folder, board and time. (Older session files hold copies of
 * learner_edit events; trace-report reads them and drops duplicates.)
 *
 * gap_ms is the time from the end of the previous call in this session (from
 * session_open for the first call) to the start of this one: the model's time,
 * or the person thinking or talking (MCP has no turn boundaries). Writes are
 * queued and never awaited by a tool call; a failed write logs one warning and
 * never fails the call.
 */

/** Any single string in args (HTML, SVG paths) is cut at this length. */
const MAX_ARG_STRING = 200 * 1024
/** The text part of a tool result is cut at this length. */
const MAX_RESULT_TEXT = 32 * 1024

export function traceRoot(): string {
  return process.env.SPACE_TRACE_DIR || join(agentHomeDir(), 'traces')
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d: Date): string => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

function slug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  )
}

function cutString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[cut: ${value.length} chars in all]`
}

/** A copy of a JSON-like value with every long string cut. */
function capStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cutString(value, MAX_ARG_STRING)
  if (value === null || typeof value !== 'object' || depth > 24) return value
  if (Array.isArray(value)) return value.map((entry) => capStrings(entry, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = capStrings(entry, depth + 1)
  return out
}

let warned = false
function warnOnce(error: unknown): void {
  if (warned) return
  warned = true
  console.warn(`trace: could not write the session trace (further failures are silent): ${String(error)}`)
}

/** One folder per day; created once per process and day. */
const dirs = new Map<string, Promise<unknown>>()
function ensureDir(dir: string): Promise<unknown> {
  let ready = dirs.get(dir)
  if (!ready) {
    ready = mkdir(dir, { recursive: true })
    ready.catch(() => dirs.delete(dir))
    dirs.set(dir, ready)
  }
  return ready
}

export interface TraceOpen {
  sessionId: string
  clientName: string
  clientVersion: string | null
  folder: string | null
  /** The board shown when the client connected, when known. */
  board: string | null
}

export class SessionTrace {
  readonly file: string
  private readonly dir: string
  private readonly base: string
  private readonly openedAt = Date.now()
  /** Writes in order; each link swallows its own failure. */
  private chain: Promise<void>
  private lastEnd: number
  private images = 0
  private calls = 0
  private closed = false

  constructor(open: TraceOpen) {
    const now = new Date(this.openedAt)
    this.dir = join(traceRoot(), localDate(now))
    this.base = `${localTime(now)}-${slug(open.clientName)}-${open.sessionId.slice(0, 8)}`
    this.file = join(this.dir, `${this.base}.jsonl`)
    this.lastEnd = this.openedAt
    this.chain = this.append({
      type: 'session_open',
      t: now.toISOString(),
      session_id: open.sessionId,
      client: { name: open.clientName, version: open.clientVersion },
      folder: open.folder,
      board: open.board
    })
  }

  private append(event: Record<string, unknown>): Promise<void> {
    let line: string
    try {
      line = `${JSON.stringify(event)}\n`
    } catch (error) {
      warnOnce(error)
      return Promise.resolve()
    }
    return ensureDir(this.dir)
      .then(() => appendFile(this.file, line, 'utf8'))
      .catch(warnOnce)
  }

  private write(event: Record<string, unknown>): void {
    if (this.closed) return
    this.chain = this.chain.then(() => this.append(event))
  }

  /** Record one tool call; `board` is the board shown when it ended. Never throws. */
  call(tool: string, args: unknown, start: number, end: number, board: string | null, result: CallToolResult | null, error: unknown): void {
    try {
      if (this.closed) return
      this.calls++
      const gap = Math.max(0, start - this.lastEnd)
      this.lastEnd = Math.max(this.lastEnd, end)
      const texts: string[] = []
      const images: { file: string; bytes: number }[] = []
      for (const part of result?.content ?? []) {
        if (part.type === 'text') texts.push(part.text)
        else if (part.type === 'image') images.push(this.saveImage(part.data))
      }
      const resultText = texts.join('\n')
      const failed = error !== null || result?.isError === true
      this.write({
        type: 'tool_call',
        t: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        duration_ms: end - start,
        gap_ms: gap,
        board,
        tool,
        args: capStrings(args ?? {}),
        ok: !failed,
        result_text: cutString(resultText, MAX_RESULT_TEXT),
        ...(images.length ? { images } : {}),
        ...(failed ? { error: error !== null ? (error instanceof Error ? error.message : String(error)) : cutString(resultText, 2000) } : {})
      })
    } catch (caught) {
      warnOnce(caught)
    }
  }

  /** Write the PNG beside the trace, off the call's path. Returns its name and size. */
  private saveImage(base64: string): { file: string; bytes: number } {
    const file = `${this.base}-${++this.images}.png`
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const bytes = Math.floor((base64.length * 3) / 4) - padding
    setImmediate(() => {
      ensureDir(this.dir)
        .then(() => writeFile(join(this.dir, file), Buffer.from(base64, 'base64')))
        .catch(warnOnce)
    })
    return { file, bytes }
  }

  close(): void {
    if (this.closed) return
    this.write({ type: 'session_close', t: new Date().toISOString(), calls: this.calls, wall_ms: Date.now() - this.openedAt })
    this.closed = true
  }
}

// ---------- Learner edits ----------

/** One learner_edit line. The renderer computes the delta from the board it saves (see shared/learner-edit). */
export interface LearnerEdit extends LearnerEditDelta {
  type: 'learner_edit'
  t: string
  folder: string
  board: string
}

/** Append a learner edit to the day's learner-edits.jsonl. Never throws. */
export function writeLearnerEdit(edit: LearnerEdit): void {
  const dir = join(traceRoot(), localDate(new Date()))
  ensureDir(dir)
    .then(() => appendFile(join(dir, 'learner-edits.jsonl'), `${JSON.stringify(edit)}\n`, 'utf8'))
    .catch(warnOnce)
}
