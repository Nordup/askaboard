import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Check, ChevronRight, Copy, Loader2 } from 'lucide-react'
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

/**
 * Track whether a code line hides text to its right (for the edge fade), and
 * make sideways scrolling work with a trackpad or Shift + wheel.
 */
function useSidewaysScroll(ref: React.RefObject<HTMLElement | null>): boolean {
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setHidden(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
    const wheel = (event: WheelEvent): void => {
      if (element.scrollWidth <= element.clientWidth) return
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!sideways && !event.shiftKey) return
      // Shift + wheel on a mouse sends deltaY only: turn it into a sideways scroll.
      if (!sideways) {
        event.preventDefault()
        element.scrollLeft += event.deltaY
      }
      // Never let the gesture reach the board or the window.
      event.stopPropagation()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener('scroll', measure, { passive: true })
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
      element.removeEventListener('wheel', wheel)
    }
  }, [ref])
  return hidden
}

/** One command (or snippet) on one line: scrolls sideways, never wraps; copy pinned right. */
function CodeLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const textRef = useRef<HTMLElement>(null)
  const hiddenRight = useSidewaysScroll(textRef)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className={`agent-code${hiddenRight ? ' agent-code--more' : ''}`}>
      <div className="agent-code__viewport">
        <code ref={textRef} className="agent-code__text" title={hiddenRight ? 'Scroll sideways for more (Shift + wheel)' : undefined}>
          {value}
        </code>
      </div>
      <button
        className="agent-code__copy"
        title={copied ? 'Copied' : 'Copy'}
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true))
        }}
      >
        {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
      </button>
    </div>
  )
}

const SHIM = '~/.learning-space/bin/learning-space'
const RELAY_COMMAND = `${SHIM} mcp`
const PLUGIN_REPO = 'Nordup/learning-space-plugins'
const STDIO_SNIPPET = `{"mcpServers":{"learning-space":{"command":"${SHIM}","args":["mcp"]}}}`

/** One manual step: a sentence, and at most one command. */
interface Step {
  text?: string
  command?: string
}

/** "Install manually" for each row. */
const MANUAL_STEPS: Record<AgentClientId, { steps: Step[]; note: string | null }> = {
  'claude-code': {
    steps: [
      { command: `claude plugin marketplace add ${PLUGIN_REPO}` },
      { command: 'claude plugin install learning-space@learning-space' },
      { text: 'Restart Claude Code, or run /reload-plugins.' }
    ],
    note: 'Inside Claude Code you can use /plugin instead.'
  },
  'claude-app': {
    steps: [
      { text: `Download learning-space.mcpb from github.com/${PLUGIN_REPO}.` },
      { text: 'Double-click it, or drag it into Claude Desktop.' }
    ],
    note: null
  },
  codex: {
    steps: [
      { command: `codex plugin marketplace add ${PLUGIN_REPO}` },
      { command: 'codex plugin add learning-space@learning-space' },
      { text: 'Restart the ChatGPT app or Codex.' }
    ],
    note: 'In the ChatGPT app: Settings → Plugins.'
  }
}

/** The second line under each row name. */
const SUBLABELS: Record<AgentClientId, string> = {
  'claude-code': 'Terminal and the Code tab in Claude Desktop',
  'claude-app': 'The Chat tab',
  codex: 'The ChatGPT desktop app and Codex CLI share one setup'
}

/** Top to bottom: group label, then its rows. */
const GROUPS: { label: string; ids: AgentClientId[] }[] = [
  { label: 'Claude', ids: ['claude-code', 'claude-app'] },
  { label: 'ChatGPT', ids: ['codex'] }
]

/** The rows before the first check answers. */
const PLACEHOLDER_CLIENTS: AgentClientStatus[] = [
  { id: 'claude-code', label: 'Claude Code', state: 'unknown', detail: null, action: null },
  { id: 'claude-app', label: 'Claude Desktop — Chat', state: 'unknown', detail: null, action: null },
  { id: 'codex', label: 'ChatGPT & Codex', state: 'unknown', detail: null, action: null }
]

function chipText(client: AgentClientStatus, checking: boolean): string {
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
      return 'Not connected'
    case 'missing':
      return client.id === 'claude-app' ? 'Not found' : 'CLI not found'
    default:
      return 'Check failed'
  }
}

/** live: the agent gets the tools; warn: it gets them twice; idle: it does not. */
function chipTone(client: AgentClientStatus, checking: boolean): 'live' | 'warn' | 'idle' {
  if (checking) return 'idle'
  if (client.state === 'both') return 'warn'
  return client.state === 'plugin' || client.state === 'manual' || client.state === 'connected' ? 'live' : 'idle'
}

const ACTION_LABELS: Record<AgentClientAction, string> = {
  'install-plugin': 'Install plugin',
  'switch-to-plugin': 'Switch to plugin',
  'remove-manual': 'Remove manual entry',
  'install-extension': 'Install extension'
}

function Steps({ steps, note }: { steps: Step[]; note: string | null }) {
  return (
    <div className="agent-steps">
      <ol className="agent-steps__list">
        {steps.map((step, index) => (
          <li key={index} className="agent-steps__step">
            <span className="agent-steps__number">{index + 1}</span>
            <div className="agent-steps__body">
              {step.text && <p className="agent-steps__text">{step.text}</p>}
              {step.command && <CodeLine value={step.command} label={`step ${index + 1} command`} />}
            </div>
          </li>
        ))}
      </ol>
      {note && <p className="agent-steps__note">{note}</p>}
    </div>
  )
}

/** A small text disclosure ("Install manually"). */
function Disclosure({ label, open, onToggle }: { label: string; open: boolean; onToggle(): void }) {
  return (
    <button className="agent-disclosure" aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={12} strokeWidth={2} className={open ? 'agent-disclosure__chevron agent-disclosure__chevron--open' : 'agent-disclosure__chevron'} />
      {label}
    </button>
  )
}

interface RowProps {
  client: AgentClientStatus
  checking: boolean
  manualOpen: boolean
  onToggleManual(): void
  onChanged(): void
}

/** One agent app: name and sublabel left, state chip and the one button right. */
function ClientRow({ client, checking, manualOpen, onToggleManual, onChanged }: RowProps) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const action = checking ? null : client.action
  const tone = chipTone(client, checking)
  const showDetail = !checking && client.detail && client.state !== 'both' && client.state !== 'plugin'

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
        <div className="agent-client__text">
          <div className="agent-client__name">{client.label}</div>
          <div className="agent-client__sub">{SUBLABELS[client.id]}</div>
        </div>
        <div className="agent-client__side">
          <span className={`agent-chip agent-chip--${tone}`} title={client.detail ?? undefined}>
            {tone === 'live' && client.state === 'plugin' ? <Check size={11} strokeWidth={2.5} /> : <span className="agent-chip__dot" />}
            {chipText(client, checking)}
          </span>
          {action && (
            <button className="agent-client__action" data-action={action} onClick={() => act(action)} disabled={busy}>
              {busy ? <Loader2 className="agent-client__spinner" size={13} strokeWidth={2} /> : ACTION_LABELS[action]}
            </button>
          )}
        </div>
      </div>
      {!checking && client.state === 'both' && (
        <div className="agent-client__note agent-client__note--warn">
          <AlertTriangle size={12} strokeWidth={2} />
          <span>Tools appear twice. Use either the plugin or a manual entry, not both: remove the manual entry and keep the plugin.</span>
        </div>
      )}
      {showDetail && <div className="agent-client__note">{client.detail}</div>}
      {result && (
        <div className={`agent-client__note ${result.ok ? 'agent-client__note--ok' : 'agent-client__note--error'}`} role="status">
          {result.ok ? <Check size={12} strokeWidth={2.25} /> : <AlertCircle size={12} strokeWidth={2} />}
          <span>{result.message}</span>
        </div>
      )}
      <Disclosure label="Install manually" open={manualOpen} onToggle={onToggleManual} />
      {manualOpen && <Steps {...MANUAL_STEPS[client.id]} />}
    </li>
  )
}

/** "Other agents": the server URL, the relay command and a stdio config snippet. */
function OtherAgents({ url, open, onToggle }: { url: string; open: boolean; onToggle(): void }) {
  return (
    <div className="agent-other">
      <button className="agent-other__toggle" aria-expanded={open} onClick={onToggle}>
        <div className="agent-client__text">
          <div className="agent-client__name">Other agents</div>
          <div className="agent-client__sub">For VS Code, Windsurf and other MCP clients</div>
        </div>
        <ChevronRight size={14} strokeWidth={2} className={open ? 'agent-disclosure__chevron agent-disclosure__chevron--open' : 'agent-disclosure__chevron'} />
      </button>
      {open && (
        <div className="agent-other__body">
          <div className="agent-other__label">Server URL</div>
          <CodeLine value={url} label="server URL" />
          <div className="agent-other__label">Relay command</div>
          <CodeLine value={RELAY_COMMAND} label="relay command" />
          <div className="agent-other__label">Config snippet</div>
          <CodeLine value={STDIO_SNIPPET} label="config snippet" />
          <p className="agent-steps__note">HTTP clients use the URL; stdio clients use the command.</p>
        </div>
      )}
    </div>
  )
}

/** The agent apps on this Mac, grouped, with one-click setup. Only one disclosure is open at a time. */
function AgentClients({ open, url }: { open: boolean; url: string }) {
  const [status, setStatus] = useState<AgentClientsStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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
  const toggle = (key: string): void => setExpanded((value) => (value === key ? null : key))
  return (
    <>
      {GROUPS.map((group) => (
        <section className="agent-group" key={group.label}>
          <div className="agent-group__label">{group.label}</div>
          <ul className="agent-clients">
            {group.ids.map((id) => {
              const client = clients.find((entry) => entry.id === id)
              if (!client) return null
              return (
                <ClientRow
                  key={id}
                  client={client}
                  checking={checking && !status}
                  manualOpen={expanded === id}
                  onToggleManual={() => toggle(id)}
                  onChanged={refresh}
                />
              )
            })}
          </ul>
        </section>
      ))}
      <section className="agent-group">
        <OtherAgents url={url} open={expanded === 'other'} onToggle={() => toggle('other')} />
      </section>
      {error && <div className="agent-pop__empty">Could not check the agent apps: {error}</div>}
    </>
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
          <header className="agent-pop__header">
            <div className="agent-pop__title">Connect an agent</div>
            <p className="agent-pop__lede">Install once. Agents see this canvas while the app is open.</p>
          </header>
          <div className="agent-pop__body">
            {status?.state === 'error' && (
              <div className="agent-pop__error">
                <AlertCircle size={14} strokeWidth={2} />
                <span>{status.error}</span>
              </div>
            )}
            <AgentClients open={open} url={url} />
            <section className="agent-group">
              <div className="agent-group__label">Active agents</div>
              <SessionList recent={recent} all={status?.sessions ?? []} now={now} />
            </section>
            <GuideOverrideNote
              className="agent-pop__overrides"
              overrides={guideOverrides}
              onOpen={(path) => {
                setOpen(false)
                onOpenOverride(path)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
