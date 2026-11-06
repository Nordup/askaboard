import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronLeft, Plus } from 'lucide-react'
import { useMenuDismiss } from '../lib/dismiss'
import type { AgentClientId, AgentClientStatus, AgentServerStatus, AgentSessionInfo, GuideOverrides } from '@shared/space-api'
import { CLIENT_NAMES, CLIENT_ORDER, ConnectList, isInstalled, shorten, useAgentClients } from './ConnectAgents'
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

/** MCP clientInfo names → the agent app they belong to. */
const SESSION_CLIENTS: Record<string, AgentClientId> = {
  'claude-code': 'claude-code',
  'claude-ai': 'claude-app',
  'codex-mcp-client': 'codex'
}

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
      <ConnectList clients={clients} checking={checking} layout="menu" onChanged={onChanged} />
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
  const { clients, checking, error: checkError, refresh } = useAgentClients()
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = status?.sessions ?? []
  const now = useNow(open ? 1000 : 5000)

  // Detection runs on every open; the last answer stays for the next open.
  useEffect(() => {
    if (!open) return
    navigated.current = false
    setView('agents')
    refresh()
  }, [open, refresh])

  const lines = agentLines(clients?.clients ?? null, sessions)
  // Nothing installed and nothing seen: open straight into View 2.
  useEffect(() => {
    if (open && clients && !navigated.current && lines.length === 0) setView('connect')
  }, [open, clients, lines.length])

  useMenuDismiss(open, rootRef, useCallback(() => setOpen(false), []))

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
