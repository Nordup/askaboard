import { tip } from './Tooltip'
import { PanelLeft } from 'lucide-react'
import { shortcut } from '../platform'

/** The sidebar button: at the right end of the sidebar's strip beside the macOS window buttons, else first in the top bar. */
export function SidebarToggle({ hidden, onToggle }: { hidden: boolean; onToggle(): void }) {
  const label = hidden ? 'Show sidebar' : 'Hide sidebar'
  return (
    <button className="icon-button icon-button--strong icon-button--title sidebar-toggle" {...tip(label, shortcut('B'))} aria-label={label} aria-expanded={!hidden} onClick={onToggle}>
      <PanelLeft size={16} strokeWidth={1.75} />
    </button>
  )
}
