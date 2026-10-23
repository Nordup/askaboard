import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Check, ChevronRight, Copy, Loader2 } from 'lucide-react'
import type {
  AgentClientAction,
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
 * An agent counts as connected when its session made a request this
 * recently. Short-lived clients (`claude -p`) exit without closing their
 * session, so open sessions overcount.
 */
const ACTIVE_WINDOW_MS = 90_000

const KNOWN_CLIENTS: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-mcp-client': 'Codex' }

/** A readable name for an MCP clientInfo name. */
export function agentName(clientName: string): string {
  return KNOWN_CLIENTS[clientName] ?? (clientName || 'Agent')
}

function recentSessions(status: AgentServerStatus | null, now: number): AgentSessionInfo[] {
  return (status?.sessions ?? [])
    .filter((session) => now - session.lastActiveAt < ACTIVE_WINDOW_MS)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

function pillLabel(status: AgentServerStatus | null, recent: AgentSessionInfo[]): string {
  if (!status || status.state === 'starting') return 'Starting agent server…'
  if (status.state === 'error') return 'Agent server off'
  const names = [...new Set(recent.map((session) => agentName(session.clientName)))]
  if (names.length === 0) return 'No agent connected'
  if (names.length === 1) return `${names[0]} connected`
  return `${names.length} agents connected`
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Re-render on a timer, so "active 12 s ago" and the 90 s window stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="agent-pop__row">
      {label && <div className="agent-pop__label">{label}</div>}
      <div className="agent-pop__code">
        <code>{value}</code>
        <button
          className="agent-pop__copy"
          title={copied ? 'Copied' : 'Copy'}
          aria-label={`Copy ${label || 'command'}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true))
          }}
        >
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
        </button>
      </div>
    </div>
  )
}

const SHIM = '~/.learning-space/bin/learning-space'

/** The by-hand commands in "Advanced". */
const MANUAL_COMMANDS = {
  claude: `claude mcp add --scope user learning-space -- ${SHIM} mcp`,
  codex: `codex mcp add learning-space -- ${SHIM} mcp`
}

/** The rows before the first check answers. */
const PLACEHOLDER_CLIENTS: AgentClientStatus[] = [
  { id: 'claude-code', label: 'Claude Code', state: 'unknown', detail: null, action: null },
  { id: 'codex', label: 'Codex', state: 'unknown', detail: null, action: null },
  { id: 'claude-app', label: 'Claude app', state: 'unknown', detail: null, action: null }
]

function stateText(client: AgentClientStatus, checking: boolean): string {
  if (checking) return 'Checking…'
  switch (client.state) {
    case 'plugin':
      return 'Plugin installed'
    case 'manual':
      return 'Connected by hand'
    case 'both':
      return 'Both'
    case 'connected':
      return 'Extension installed'
    case 'available':
      return client.detail ?? 'Not connected'
    case 'missing':
      return client.id === 'claude-app' ? 'Not found' : 'CLI not found'
    default:
      return client.detail ? `Check failed: ${client.detail}` : 'Status unknown'
  }
}

const ACTION_LABELS: Record<AgentClientAction, string> = {
  'install-plugin': 'Install plugin',
  'switch-to-plugin': 'Switch to plugin',
  'remove-manual': 'Remove manual entry',
  'install-extension': 'Install'
}

/** Green dot: the agent gets the tools (one way or the other). */
function isLinked(client: AgentClientStatus): boolean {
  return client.state === 'plugin' || client.state === 'manual' || client.state === 'both' || client.state === 'connected'
}

/** One agent app: its state and the one button for that state. */
function ClientRow({ client, checking, onChanged }: { client: AgentClientStatus; checking: boolean; onChanged(): void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const action = checking ? null : client.action

  const act = (chosen: AgentClientAction): void => {
    setBusy(true)
    setResult(null)
    window.space
      .connectAgentClient(client.id, chosen)
      .then((value) => setResult(value))
      .catch((error: unknown) => setResult({ ok: false, message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        setBusy(false)
        // Re-detect after every action, also after a failure (a step can half succeed).
        onChanged()
      })
  }

  return (
    <li className="agent-client" data-client={client.id} data-state={client.state}>
      <div className="agent-client__line">
        <span className={isLinked(client) ? 'status-dot status-dot--live' : 'status-dot'} />
        <span className="agent-client__name">{client.label}</span>
        <span className="agent-client__state" title={client.detail ?? undefined}>
          {client.state === 'plugin' && !checking && <Check size={12} strokeWidth={2.25} className="agent-client__check" />}
          {stateText(client, checking)}
        </span>
        {action && (
          <button className="agent-client__action" data-action={action} onClick={() => act(action)} disabled={busy}>
            {busy ? <Loader2 className="agent-client__spinner" size={13} strokeWidth={2} /> : ACTION_LABELS[action]}
          </button>
        )}
      </div>
      {!checking && client.state === 'both' && (
        <div className="agent-client__warn">
          <AlertTriangle size={12} strokeWidth={2} />
          <span>Tools appear twice. Remove the manual entry and keep the plugin.</span>
        </div>
      )}
      {result && (
        <div className={`agent-client__result${result.ok ? ' agent-client__result--ok' : ''}`} role="status">
          {result.ok ? <Check size={12} strokeWidth={2.25} /> : <AlertCircle size={12} strokeWidth={2} />}
          <span>{result.message}</span>
        </div>
      )}
      {!checking && client.state === 'missing' && client.id !== 'claude-app' && (
        <div className="agent-client__hint">Install {client.label}, then open this popover again.</div>
      )}
    </li>
  )
}

/** The agent apps on this Mac, with one-click setup. */
function AgentClients({ open }: { open: boolean }) {
  const [status, setStatus] = useState<AgentClientsStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    setChecking(true)
    window.space
      .getAgentClients()
      .then((value) => {
        setStatus(value)
        setError(null)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setChecking(false))
  }

  useEffect(() => {
    if (open) refresh()
  }, [open])

  const clients = status?.clients ?? PLACEHOLDER_CLIENTS
  return (
    <>
      <ul className="agent-clients">
        {clients.map((client) => (
          <ClientRow key={client.id} client={client} checking={checking && !status} onChanged={refresh} />
        ))}
      </ul>
      {error && <div className="agent-pop__empty">Could not check the agent apps: {error}</div>}
    </>
  )
}

/** The by-hand setup, collapsed by default. */
function Advanced({ url }: { url: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="agent-advanced">
      <button className="agent-advanced__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={13} strokeWidth={2} className={open ? 'agent-advanced__chevron agent-advanced__chevron--open' : 'agent-advanced__chevron'} />
        Advanced: connect by hand
      </button>
      {open && (
        <div className="agent-advanced__body">
          <p className="agent-advanced__note">Use either the plugin or a manual entry, not both.</p>
          <CopyRow label="Claude Code" value={MANUAL_COMMANDS.claude} />
          <CopyRow label="Codex" value={MANUAL_COMMANDS.codex} />
          <CopyRow label="Server URL (HTTP clients)" value={url} />
        </div>
      )}
    </div>
  )
}

function SessionList({ recent, all, now }: { recent: AgentSessionInfo[]; all: AgentSessionInfo[]; now: number }) {
  if (!recent.length) {
    const last = [...all].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
    return (
      <div className="agent-pop__empty">
        {last ? `No agent active in the last 90 s. Last: ${agentName(last.clientName)}, ${ago(last.lastActiveAt, now)}.` : 'No agent has connected yet.'}
      </div>
    )
  }
  return (
    <ul className="agent-pop__sessions">
      {recent.map((session) => (
        <li key={session.id}>
          <span className="status-dot status-dot--live" />
          <span className="agent-pop__name" title={session.clientName}>
            {agentName(session.clientName)}
          </span>
          <span className="agent-pop__since">active {ago(session.lastActiveAt, now)}</span>
        </li>
      ))}
    </ul>
  )
}

/** The top-bar agent status, with the "Connect an agent" popover. */
export function AgentPill({ status, activityAt, guideOverrides, onOpenOverride }: AgentPillProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  const now = useNow(open ? 1000 : 5000)
  const recent = recentSessions(status, now)
  const live = status?.state === 'listening' && recent.length > 0
  const dotClass = status?.state === 'error' ? 'status-dot status-dot--error' : live ? 'status-dot status-dot--live' : 'status-dot'
  const url = status?.url ?? 'http://127.0.0.1:47821/mcp'

  return (
    <div className="agent-pill" ref={rootRef}>
      <button className={`pill${open ? ' pill--open' : ''}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {/* The key restarts the pulse animation on every tool call. */}
        <span key={activityAt ?? 0} className={`${dotClass}${activityAt && live ? ' status-dot--pulse' : ''}`} />
        {pillLabel(status, recent)}
      </button>
      {open && (
        <div className="agent-pop" role="dialog" aria-label="Connect an agent">
          <div className="agent-pop__title">Connect an agent</div>
          <p className="agent-pop__lede">Install the plugin once. The agent then sees this canvas while the app is open.</p>
          {status?.state === 'error' && (
            <div className="agent-pop__error">
              <AlertCircle size={14} strokeWidth={2} />
              <span>{status.error}</span>
            </div>
          )}
          <AgentClients open={open} />
          <Advanced url={url} />
          <div className="agent-pop__divider" />
          <div className="agent-pop__label">Active agents</div>
          <SessionList recent={recent} all={status?.sessions ?? []} now={now} />
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
