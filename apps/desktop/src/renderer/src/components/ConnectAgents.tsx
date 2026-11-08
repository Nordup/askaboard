import { useCallback, useState, type ReactNode } from 'react'
import { Check, ExternalLink, Loader2 } from 'lucide-react'
import type { AgentClientAction, AgentClientId, AgentClientStatus, AgentClientsStatus } from '@shared/space-api'
import { SettingRow } from './settings/parts'

/**
 * "Connect an agent": one row per agent app (main/connect.ts detects them and runs the install), with its one control
 * (Install, Installed, a spinner) and a problem as one line with Fix or Retry, then the manual-setup link. One
 * component in two places: the agent popover's second view (AgentPill.tsx, `layout="menu"`) and Settings > Agents
 * (`layout="settings"`, rows with a description). Each place keeps its own detection (useAgentClients); the line after
 * an action is main's (AgentClientStatus.last, texts in main/connect.ts), so both places show the same one.
 */

export const MANUAL_SETUP_URL = 'https://github.com/Nordup/askaboard-plugins#manual-setup'

/** The agent apps, in list order. Internal ids stay as connect.ts names them. */
export const CLIENT_NAMES: Record<AgentClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-app': 'Claude Desktop',
  codex: 'ChatGPT and Codex'
}
export const CLIENT_ORDER: AgentClientId[] = ['claude-code', 'claude-app', 'codex']

/** Settings > Agents: what the install adds to each app. */
const CLIENT_DESCRIPTIONS: Record<AgentClientId, string> = {
  'claude-code': 'The Askaboard plugin for Claude Code',
  'claude-app': 'The Askaboard extension for Claude Desktop',
  codex: 'The Askaboard plugin for ChatGPT and Codex'
}

export function isInstalled(client: AgentClientStatus): boolean {
  return client.state === 'plugin' || client.state === 'manual' || client.state === 'both' || client.state === 'connected'
}

/** The first line of an error, short enough for one row. */
export function shorten(message: string): string {
  const line = message.split('\n')[0].trim()
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

/** Detection of the agent apps: refresh runs it again; the last answer stays. */
export function useAgentClients(): { clients: AgentClientsStatus | null; checking: boolean; error: string | null; refresh(): Promise<void> } {
  const [clients, setClients] = useState<AgentClientsStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback((): Promise<void> => {
    setChecking(true)
    return window.space
      .getAgentClients()
      .then((value) => {
        setClients(value)
        setError(null)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setChecking(false))
  }, [])
  return { clients, checking, error, refresh }
}

/** A problem line under a row: warning text and one inline text button. */
function Problem({ text, fix, onFix }: { text: string; fix: string; onFix(): void }) {
  return (
    <div className="menu__line menu__line--warn">
      <span className="menu__line-text">{text}</span>
      <button className="menu__fix" onClick={onFix}>
        {fix}
      </button>
    </div>
  )
}

type Layout = 'menu' | 'settings'

function ConnectRow({ id, client, checking, layout, onChanged }: { id: AgentClientId; client: AgentClientStatus | undefined; checking: boolean; layout: Layout; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState(false)

  const run = (action: AgentClientAction): void => {
    setBusy(true)
    window.space
      .connectAgentClient(id, action)
      .catch((error: unknown) => console.error(`connect ${id}: ${error instanceof Error ? error.message : String(error)}`))
      // Re-detect after every action, also after a failure (a step can half succeed); the new status carries its line.
      .then(onChanged)
      .finally(() => setBusy(false))
  }

  const installed = client ? isInstalled(client) : false
  let control: ReactNode
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

  const last = busy ? null : (client?.last ?? null)
  const failed = last && !last.result.ok ? last : null
  const done = last?.result.ok ? last : null
  const lines = (
    <>
      {failed && <Problem text={failed.result.message} fix="Retry" onFix={() => run(failed.action)} />}
      {!busy && !failed && client?.state === 'both' && <Problem text="Also added by hand, so tools appear twice" fix="Fix" onFix={() => run('remove-manual')} />}
      {!busy && !failed && client?.state === 'manual' && <Problem text="Added by hand" fix="Fix" onFix={() => run('switch-to-plugin')} />}
      {!busy && !failed && client?.state === 'unknown' && client.detail && <Problem text={shorten(client.detail)} fix="Retry" onFix={onChanged} />}
      {done && <div className="menu__line">{done.result.message}</div>}
    </>
  )

  if (layout === 'settings')
    return (
      <SettingRow name={CLIENT_NAMES[id]} description={CLIENT_DESCRIPTIONS[id]} lines={lines} data={{ 'data-client': id, 'data-state': client?.state ?? 'unknown' }}>
        {control}
      </SettingRow>
    )
  return (
    <div className="agent-connect" data-client={id} data-state={client?.state ?? 'unknown'}>
      <div className="menu__row">
        <span className="menu__name">{CLIENT_NAMES[id]}</span>
        <span className="menu__control">{control}</span>
      </div>
      {lines}
    </div>
  )
}

/** The rows and the manual-setup link. */
export function ConnectList({ clients, checking, layout, onChanged }: { clients: AgentClientStatus[] | null; checking: boolean; layout: Layout; onChanged(): Promise<void> }) {
  return (
    <>
      {CLIENT_ORDER.map((id) => (
        <ConnectRow key={id} id={id} client={clients?.find((entry) => entry.id === id)} checking={checking} layout={layout} onChanged={onChanged} />
      ))}
      {layout === 'menu' && <div className="menu__separator" />}
      <button className="menu__item menu__item--quiet" onClick={() => window.open(MANUAL_SETUP_URL, '_blank')}>
        <span className="menu__icon">
          <ExternalLink size={13} strokeWidth={1.75} />
        </span>
        <span className="menu__label">Manual setup and other agents</span>
      </button>
    </>
  )
}
