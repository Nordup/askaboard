import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import { telemetryIdentity, type TelemetryIdentity } from './analytics-id'

/**
 * Usage data (decision P24). The delivery is adapted from T3 Code (MIT; THIRD_PARTY_NOTICES.md): an
 * in-memory buffer, a flush every 10 s in batches of 20, retries with backoff, one short flush at
 * quit. Events go as PostHog batches to our ingest (P25), which keeps a copy and forwards them.
 *
 * Only names, enums, counts, durations and booleans go into properties: never board content,
 * scene text, said lines, file names, folder paths, tool arguments or error messages.
 *
 * Env: ASKABOARD_TELEMETRY_ENABLED (false turns it off; under `npm run dev` only true turns
 * it on), ASKABOARD_TELEMETRY_HOST (the ingest). Each event carries product 'desktop' and
 * the channel (release or dev), set at build time (electron.vite.config.ts, ASKABOARD_TELEMETRY_CHANNEL).
 */

/** Our ingest ignores the key (it adds its own); PostHog's wire format has the field. */
const API_KEY = ''
const DEFAULT_HOST = 'https://api.askaboard.com'

// Retry delays shorter than this still wait for the next background check.
const FLUSH_INTERVAL_MS = 10_000
const FLUSH_BATCH_SIZE = 20
const MAX_BUFFERED_EVENTS = 1_000
// A hung send would hold the flush for the next background flush.
const SEND_TIMEOUT_MS = 10_000
// Quit waits for this flush; events it cannot send in time are dropped.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 1_000
// A failed batch is tried again until it has failed for this long.
const MAX_BATCH_RETRY_MS = 30 * 60_000
const RETRY_BASE_DELAY_MS = 2_000
const RETRY_MAX_DELAY_MS = 300_000
// These statuses reject the batch itself; unlike 408/429, retrying cannot help.
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413])

/** `random` is in [0, 1). */
function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1))
  return Math.round(ceiling / 2 + (ceiling / 2) * random)
}

type Value = string | number | boolean | null
type Properties = Readonly<Record<string, Value>>

interface BufferedEvent {
  uuid: string
  event: string
  properties?: Properties
  capturedAt: string
}

interface DeliveryState {
  failedBatch: BufferedEvent[]
  batchAttempts: number
  firstFailedAt: number
  failures: number
  retryAt: number
}

class StatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return undefined
}

/** The dev renderer (electron-vite dev) counts as a dev run, as T3's dev runner: off unless the variable turns it on. */
const devRun = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const enabled = parseBoolean(process.env.ASKABOARD_TELEMETRY_ENABLED) ?? !devRun
const host = (process.env.ASKABOARD_TELEMETRY_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '')

/** A UUIDv7 (RFC 9562): 48 bits of Unix ms, then random bits; PostHog deduplicates retries by it. */
function uuidV7(): string {
  const bytes = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

let buffer: BufferedEvent[] = []
let delivery: DeliveryState = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures: 0, retryAt: 0 }
/** Null until start(); its value null when no id could be made (then nothing is kept or sent). */
let identity: Promise<TelemetryIdentity> | null = null
let resolved: TelemetryIdentity | null = null
let flushing: Promise<void> | null = null
const recordedOwners = new Set<string>()

/** Keep one event for the next flush. Never throws; does nothing when usage data is off. */
export function record(event: string, properties?: Properties): void {
  if (!enabled || (resolved && !resolved.distinctId)) return
  try {
    buffer.push({ uuid: uuidV7(), event, ...(properties ? { properties } : {}), capturedAt: new Date().toISOString() })
    if (buffer.length > MAX_BUFFERED_EVENTS) buffer = buffer.slice(buffer.length - MAX_BUFFERED_EVENTS)
  } catch {
    // Best effort: an event that cannot be made is dropped.
  }
}

async function sendBatch(events: BufferedEvent[]): Promise<void> {
  const id = await identity!
  if (!id.distinctId) return
  const common = {
    ...(id.installId === null ? {} : { install_id: id.installId }),
    platform: process.platform,
    arch: process.arch,
    os_version: process.getSystemVersion(),
    app_version: app.getVersion(),
    product: 'desktop',
    channel: __LS_TELEMETRY_CHANNEL__
  }
  const payload = {
    api_key: API_KEY,
    batch: events.map((event) => ({
      uuid: event.uuid,
      event: event.event,
      distinct_id: id.distinctId,
      properties: { ...event.properties, ...common },
      timestamp: event.capturedAt
    }))
  }
  const response = await fetch(`${host}/batch/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  })
  if (!response.ok) throw new StatusError(response.status)
}

async function flushNow(): Promise<void> {
  // Back off even after a dropped batch, so a rejecting endpoint cannot drain the queue in a tight loop.
  while (true) {
    const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : buffer.splice(0, FLUSH_BATCH_SIZE)
    if (batch.length === 0) return
    try {
      await sendBatch(batch)
      delivery = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures: 0, retryAt: 0 }
      continue
    } catch (error) {
      const now = Date.now()
      const failures = delivery.failures + 1
      const batchAttempts = delivery.batchAttempts + 1
      const firstFailedAt = delivery.batchAttempts === 0 ? now : delivery.firstFailedAt
      const retryAt = now + retryDelayMs(failures, Math.random())
      const rejected = error instanceof StatusError && REJECTED_BATCH_STATUSES.has(error.status)
      if (!rejected && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        delivery = { failedBatch: batch, batchAttempts, firstFailedAt, failures, retryAt }
        return
      }
      delivery = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures, retryAt }
      console.warn(`analytics: dropped ${batch.length} events ${rejected ? 'the endpoint rejected' : 'after repeated send failures'}`)
      return
    }
  }
}

/** One flush at a time: the background flush and the quit flush must not send the same batch at once. */
function flush(): Promise<void> {
  flushing ??= flushNow()
    .catch(() => undefined)
    .finally(() => {
      flushing = null
    })
  return flushing
}

/** Read the ids, start the flush loop and the quit flush. Call once, when the app is ready. */
export function start(): void {
  if (!enabled || identity) return
  identity = telemetryIdentity().then(
    (id) => {
      resolved = id
      if (!id.distinctId) buffer = []
      else for (const owner of id.owners) recordOwner(owner.source, owner.ownerId)
      return id
    },
    (): TelemetryIdentity => {
      resolved = { distinctId: null, installId: null, owners: [] }
      buffer = []
      return resolved
    }
  )
  setInterval(() => {
    if (Date.now() >= delivery.retryAt) void flush()
  }, FLUSH_INTERVAL_MS).unref()
  let quitFlushDone = false
  // Registered after index.ts's own will-quit handler, which has run by then; app.exit then ends the process without a second quit.
  app.on('will-quit', (event) => {
    if (quitFlushDone || (buffer.length === 0 && delivery.failedBatch.length === 0)) return
    quitFlushDone = true
    event.preventDefault()
    const timeout = new Promise<void>((done) => setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS))
    void Promise.race([flush(), timeout]).finally(() => app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0))
  })
}

/** account_linked (decision P38): each account once per process (T3's recordOwners, server owners only). provider: openai or claude; account_id: the hash. */
function recordOwner(source: string, ownerId: string): void {
  const key = `${source}:${ownerId}`
  if (recordedOwners.has(key)) return
  recordedOwners.add(key)
  record('account_linked', { provider: source, account_id: ownerId })
}

/** An MCP client's name as a known agent app, else "other" (the raw name is not sent). */
export function agentClientName(raw: string | undefined): string {
  const name = (raw ?? '').toLowerCase()
  // Claude Desktop connects as "claude-ai", or as "local-agent-mode-<extension name>" from its local agent mode.
  if (name.includes('claude-ai') || name.includes('local-agent-mode') || name.includes('claude desktop') || name.includes('claude-desktop')) return 'claude-desktop'
  if (name.includes('claude')) return 'claude-code'
  if (name.includes('codex')) return 'codex'
  if (name.includes('cursor')) return 'cursor'
  return 'other'
}

/** An MCP client's version when it is a plain version number (1.2.3, 2.0.1-beta.4), else null: free text is not sent. */
export function agentClientVersion(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d{1,9}(\.\d{1,9}){0,3}([-+][0-9A-Za-z.-]{1,20})?$/.test(raw) ? raw : null
}

// ---------- board_opened ----------

/** Boards made since they were last shown, and the board an agent's open_board asked for: the next show of that path tells how it opened. */
const createdBoards = new Set<string>()
let agentOpen: string | null = null

export function boardCreated(root: string, path: string): void {
  createdBoards.add(`${root}\n${path}`)
}

export function agentOpensBoard(root: string | null, path: string): void {
  agentOpen = root ? `${root}\n${path}` : null
}

/** The window shows a board (renderer openBoard → IPC.setLastBoard). */
export function boardShown(root: string, path: string): void {
  const key = `${root}\n${path}`
  const created = createdBoards.delete(key)
  const by = agentOpen === key ? 'agent' : 'learner'
  if (agentOpen === key) agentOpen = null
  record('board_opened', { created, by })
}
