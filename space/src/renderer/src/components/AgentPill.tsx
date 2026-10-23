import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import type { AgentServerStatus, AgentSessionInfo, GuideOverrides } from '@shared/space-api'
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
      <div className="agent-pop__label">{label}</div>
      <div className="agent-pop__code">
        <code>{value}</code>
        <button
          className="agent-pop__copy"
          title={copied ? 'Copied' : 'Copy'}
          aria-label={`Copy ${label}`}
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
          <p className="agent-pop__lede">
            Run one command in a terminal. The agent then sees this canvas while the app is open.
          </p>
          {status?.state === 'error' && (
            <div className="agent-pop__error">
              <AlertCircle size={14} strokeWidth={2} />
              <span>{status.error}</span>
            </div>
          )}
          <CopyRow label="Claude Code" value={`claude mcp add --transport http learning-space ${url}`} />
          <CopyRow label="Codex" value={`codex mcp add learning-space --url ${url}`} />
          <CopyRow label="Server URL" value={url} />
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
