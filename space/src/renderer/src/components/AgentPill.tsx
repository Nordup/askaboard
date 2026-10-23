import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronLeft, ExternalLink, Loader2, Plus } from 'lucide-react'
import type {
  AgentClientAction,
  AgentClientId,
  AgentClientStatus,
  AgentClientsStatus,
  AgentServerStatus,
  AgentSessionInfo,
  ConnectResult,
  GuideOverrides
} from '@shared/space-api'
import { GuideOverrideNote } from './GuideOverrideNote'

interface AgentPillProps {
  status: AgentServerStatus | null
  /** Time (ms) of the last tool call from any agent; the dot pulses when it changes. */
  activityAt: number | null
  /** The open folder's guide and instructions overrides. */
  guideOverrides: GuideOverrides | null
  onOpenOverride(path: string): void
}

/**
 * An agent counts as active when its session made a request this recently.
 * Short-lived clients (`claude -p`) exit without closing their session, so
 * open sessions overcount.
 */
const ACTIVE_WINDOW_MS = 90_000

const MANUAL_SETUP_URL = 'https://github.com/Nordup/learning-space-plugins#manual-setup'

/** The agent apps, in popover order. Internal ids stay as connect.ts names them. */
const CLIENT_NAMES: Record<AgentClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-app': 'Claude Desktop',
  codex: 'ChatGPT and Codex'
}
const CLIENT_ORDER: AgentClientId[] = ['claude-code', 'claude-app', 'codex']

/** MCP clientInfo names → the agent app they belong to. */
const SESSION_CLIENTS: Record<string, AgentClientId> = {
  'claude-code': 'claude-code',
  'claude-ai': 'claude-app',
  'codex-mcp-client': 'codex'
}

/** "Restart … to finish" after a plugin change. */
const RESTART_NAMES: Partial<Record<AgentClientId, string>> = { 'claude-code': 'Claude Code', codex: 'ChatGPT' }

/** A readable name for an MCP clientInfo name. */
export function agentName(clientName: string): string {
  const id = SESSION_CLIENTS[clientName]
  return id ? CLIENT_NAMES[id] : clientName || 'Agent'
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Re-render on a timer, so "12 s ago" and the 90 s window stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** One agent in View 1: from detection, from sessions, or both. */
interface AgentLine {
  key: string
  name: string
  lastActiveAt: number | null
}

function isInstalled(client: AgentClientStatus): boolean {
  return client.state === 'plugin' || client.state === 'manual' || client.state === 'both' || client.state === 'connected'
}

/** Installed agents plus every agent a session came from, most recent first. */
function agentLines(clients: AgentClientStatus[] | null, sessions: AgentSessionInfo[]): AgentLine[] {
  const lines = new Map<string, AgentLine>()
  for (const id of CLIENT_ORDER) {
    const client = clients?.find((entry) => entry.id === id)
    if (client && isInstalled(client)) lines.set(id, { key: id, name: CLIENT_NAMES[id], lastActiveAt: null })
  }
  for (const session of sessions) {
    const key = SESSION_CLIENTS[session.clientName] ?? `raw:${session.clientName}`
    const line = lines.get(key) ?? { key, name: agentName(session.clientName), lastActiveAt: null }
    line.lastActiveAt = Math.max(line.lastActiveAt ?? 0, session.lastActiveAt)
    lines.set(key, line)
  }
  return [...lines.values()].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
}

function activeNames(sessions: AgentSessionInfo[], now: number): string[] {
  const recent = sessions.filter((session) => now - session.lastActiveAt < ACTIVE_WINDOW_MS)
  return [...new Set(recent.map((session) => agentName(session.clientName)))]
}

function pillLabel(status: AgentServerStatus | null, active: string[]): string {
  if (!status || status.state === 'starting') return 'Starting…'
  if (status.state === 'error') return 'Agent server off'
  if (active.length === 0) return 'No agent'
  if (active.length === 1) return active[0]
  return `${active.length} agents`
}

// ---------- View 1: Agents ----------

function AgentsView({ lines, checking, now, onConnect }: { lines: AgentLine[]; checking: boolean; now: number; onConnect(): void }) {
  return (
    <>
      <div className="menu__heading">Agents</div>
      {lines.map((line) => {
        const active = line.lastActiveAt !== null && now - line.lastActiveAt < ACTIVE_WINDOW_MS
        const meta = line.lastActiveAt === null ? 'not connected yet' : active ? 'active now' : ago(line.lastActiveAt, now)
        return (
          <div key={line.key} className="menu__row" data-agent={line.key}>
            <span className={active ? 'status-dot status-dot--live' : 'status-dot'} />
            <span className="menu__name">{line.name}</span>
            <span className="menu__meta">{meta}</span>
          </div>
        )
      })}
      {lines.length === 0 && <div className="menu__row menu__meta">{checking ? 'Checking…' : 'No agent yet'}</div>}
      <div className="menu__separator" />
      <button className="menu__item menu__item--quiet" data-nav="connect" onClick={onConnect}>
        <span className="menu__icon">
          <Plus size={14} strokeWidth={1.75} />
        </span>
        <span className="menu__label">Connect an agent</span>
      </button>
    </>
  )
}

// ---------- View 2: Connect an agent ----------

/** A problem line under a row: warning text and one inline text button. */
function Problem({ text, fix, onFix }: { text: string; fix: string; onFix(): void }) {
  return (
    <div className="menu__line menu__line--warn">
      <span className="menu__line-text" title={text}>
        {text}
      </span>
      <button className="menu__fix" onClick={onFix}>
        {fix}
      </button>
    </div>
  )
}

/** The first line of an error, short enough for one row. */
function shorten(message: string): string {
  const line = message.split('\n')[0].trim()
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

function ConnectRow({ id, client, checking, onChanged }: { id: AgentClientId; client: AgentClientStatus | undefined; checking: boolean; onChanged(): void }) {
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<{ action: AgentClientAction; result: ConnectResult } | null>(null)

  const run = (action: AgentClientAction): void => {
    setBusy(true)
    setLast(null)
    window.space
      .connectAgentClient(id, action)
      .then((result) => setLast({ action, result }))
      .catch((error: unknown) => setLast({ action, result: { ok: false, message: error instanceof Error ? error.message : String(error) } }))
      .finally(() => {
        setBusy(false)
        // Re-detect after every action, also after a failure (a step can half succeed).
        onChanged()
      })
  }

  const installed = client ? isInstalled(client) : false
  let control: React.ReactNode
  if (busy || (checking && !client)) control = <Loader2 className="menu__spinner" size={14} strokeWidth={2} aria-label="Working" />
  else if (installed)
    control = (
      <span className="menu__status">
        <Check size={13} strokeWidth={2.25} />
        Installed
      </span>
    )
  else if (client?.state === 'missing') control = <span className="menu__meta">Not found</span>
  else
    control = (
      <button className="btn-sm" data-action={client?.action ?? 'install'} disabled={!client?.action} onClick={() => client?.action && run(client.action)}>
        Install
      </button>
    )

  const failed = last && !last.result.ok ? last : null
  const restart = RESTART_NAMES[id]
  const done = last?.result.ok && !busy ? last : null

  return (
    <div className="agent-connect" data-client={id} data-state={client?.state ?? 'unknown'}>
      <div className="menu__row">
        <span className="menu__name">{CLIENT_NAMES[id]}</span>
        <span className="menu__control">{control}</span>
      </div>
      {!busy && failed && <Problem text={shorten(failed.result.message)} fix="Retry" onFix={() => run(failed.action)} />}
      {!busy && !failed && client?.state === 'both' && <Problem text="Also added by hand, so tools appear twice" fix="Fix" onFix={() => run('remove-manual')} />}
      {!busy && !failed && client?.state === 'manual' && <Problem text="Added by hand" fix="Fix" onFix={() => run('switch-to-plugin')} />}
      {!busy && !failed && client?.state === 'unknown' && client.detail && <Problem text={shorten(client.detail)} fix="Retry" onFix={onChanged} />}
      {done && restart && <div className="menu__line">Restart {restart} to finish</div>}
      {done && !restart && <div className="menu__line">Confirm the install in Claude Desktop</div>}
    </div>
  )
}

function ConnectView({ clients, checking, onBack, onChanged }: { clients: AgentClientStatus[] | null; checking: boolean; onBack(): void; onChanged(): void }) {
  return (
    <>
      <button className="menu__item" data-nav="back" onClick={onBack}>
        <span className="menu__icon">
          <ChevronLeft size={14} strokeWidth={2} />
        </span>
        <span className="menu__label">Connect an agent</span>
      </button>
      <div className="menu__separator" />
      {CLIENT_ORDER.map((id) => (
        <ConnectRow key={id} id={id} client={clients?.find((entry) => entry.id === id)} checking={checking} onChanged={onChanged} />
      ))}
      <div className="menu__separator" />
      <button className="menu__item menu__item--quiet" onClick={() => window.open(MANUAL_SETUP_URL, '_blank')}>
        <span className="menu__icon">
          <ExternalLink size={13} strokeWidth={1.75} />
        </span>
        <span className="menu__label">Manual setup and other agents</span>
      </button>
    </>
  )
}

// ---------- The pill ----------

/** The top-bar agent status, with the Agents / Connect an agent popover. */
export function AgentPill({ status, activityAt, guideOverrides, onOpenOverride }: AgentPillProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'agents' | 'connect'>('agents')
  /** The user picked a view this time, so detection must not switch it. */
  const navigated = useRef(false)
  const [clients, setClients] = useState<AgentClientsStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = status?.sessions ?? []
  const now = useNow(open ? 1000 : 5000)

  const refresh = (): void => {
    setChecking(true)
    window.space
      .getAgentClients()
      .then((value) => {
        setClients(value)
        setCheckError(null)
      })
      .catch((reason: unknown) => setCheckError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setChecking(false))
  }

  // Detection runs on every open; the last answer stays for the next open.
  useEffect(() => {
    if (!open) return
    navigated.current = false
    setView('agents')
    refresh()
  }, [open])

  const lines = agentLines(clients?.clients ?? null, sessions)
  // Nothing installed and nothing seen: open straight into View 2.
  useEffect(() => {
    if (open && clients && !navigated.current && lines.length === 0) setView('connect')
  }, [open, clients, lines.length])

  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  const go = (next: 'agents' | 'connect'): void => {
    navigated.current = true
    setView(next)
  }

  const active = activeNames(sessions, now)
  const live = status?.state === 'listening' && active.length > 0
  const dotClass = status?.state === 'error' ? 'status-dot status-dot--error' : live ? 'status-dot status-dot--live' : 'status-dot'

  return (
    <div className="agent-pill" ref={rootRef}>
      <button className={`pill${open ? ' pill--open' : ''}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {/* The key restarts the pulse animation on every tool call. */}
        <span key={activityAt ?? 0} className={`${dotClass}${activityAt && live ? ' status-dot--pulse' : ''}`} />
        {pillLabel(status, active)}
      </button>
      {open && (
        <div className="menu agent-pop" role="dialog" aria-label={view === 'agents' ? 'Agents' : 'Connect an agent'} data-view={view}>
          {status?.state === 'error' && (
            <div className="menu__line menu__line--error">
              <AlertCircle size={12} strokeWidth={2} />
              <span>{status.error}</span>
            </div>
          )}
          {view === 'agents' ? (
            <AgentsView lines={lines} checking={checking && !clients} now={now} onConnect={() => go('connect')} />
          ) : (
            <ConnectView clients={clients?.clients ?? null} checking={checking} onBack={() => go('agents')} onChanged={refresh} />
          )}
          {checkError && <div className="menu__line menu__line--error">Could not check the agent apps: {shorten(checkError)}</div>}
          <GuideOverrideNote
            className="agent-pop__overrides"
            overrides={guideOverrides}
            onOpen={(path) => {
              setOpen(false)
              onOpenOverride(path)
            }}
          />
        </div>
      )}
    </div>
  )
}
