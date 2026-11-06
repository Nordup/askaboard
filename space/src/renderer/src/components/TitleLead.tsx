import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { tip } from './Tooltip'
import { SidebarToggle } from './SidebarToggle'
import { KEYS } from '../board/commands'

/** Back and Forward through the boards the window showed (U11; App.tsx owns the history). */
export interface BoardNav {
  canBack: boolean
  canForward: boolean
  onBack(): void
  onForward(): void
}

/** A chevron's drawing fills less of its box than the other 16 px icons: at 20 px (stroke scaled back to the same 1.4 px line) it reads as the same size. */
const CHEVRON = { size: 20, strokeWidth: 1.4 }

/**
 * The title row's lead: Back, Forward and the sidebar button, from --chrome-reserve. The sidebar's strip shows it
 * while the sidebar shows, the top bar while it is hidden (with New board after it, as children). One group in both
 * places, so the three buttons keep the same x when the sidebar hides or shows.
 */
export function TitleLead({ sidebarHidden, onToggleSidebar, nav, children }: { sidebarHidden: boolean; onToggleSidebar(): void; nav: BoardNav; children?: ReactNode }) {
  return (
    <span className="title-lead">
      <button className="icon-button icon-button--strong icon-button--title" {...tip('Back', KEYS.back)} aria-label="Back" disabled={!nav.canBack} onClick={nav.onBack}>
        <ChevronLeft {...CHEVRON} />
      </button>
      <button className="icon-button icon-button--strong icon-button--title" {...tip('Forward', KEYS.forward)} aria-label="Forward" disabled={!nav.canForward} onClick={nav.onForward}>
        <ChevronRight {...CHEVRON} />
      </button>
      <SidebarToggle hidden={sidebarHidden} onToggle={onToggleSidebar} />
      {children}
    </span>
  )
}
