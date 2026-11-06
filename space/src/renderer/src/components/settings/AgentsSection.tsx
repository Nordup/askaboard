import { useEffect } from 'react'
import { ConnectList, shorten, useAgentClients } from '../ConnectAgents'

/** Settings > Agents: the agent popover's "Connect an agent" list (the one ConnectList), detected again at each open. */
export function AgentsSection() {
  const { clients, checking, error, refresh } = useAgentClients()
  useEffect(refresh, [refresh])
  return (
    <>
      <ConnectList clients={clients?.clients ?? null} checking={checking} layout="settings" onChanged={refresh} />
      {error && <div className="menu__line menu__line--error">Could not check the agent apps: {shorten(error)}</div>}
    </>
  )
}
