import { PanelLeft } from 'lucide-react'
import { shortcut } from '../platform'

/** The sidebar button: in the sidebar's top strip while it shows, at the same place in the top bar while it is hidden. */
export function SidebarToggle({ hidden, onToggle }: { hidden: boolean; onToggle(): void }) {
  const label = hidden ? 'Show sidebar' : 'Hide sidebar'
  return (
    <button className="icon-button icon-button--strong sidebar-toggle" title={`${label} (${shortcut('B')})`} aria-label={label} aria-expanded={!hidden} onClick={onToggle}>
      <PanelLeft size={16} strokeWidth={1.75} />
    </button>
  )
}
