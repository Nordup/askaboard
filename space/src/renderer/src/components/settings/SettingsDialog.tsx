import type { KeyboardEvent, ReactNode } from 'react'
import { Bot, Folder, Info, Keyboard, SlidersHorizontal, Volume2, X } from 'lucide-react'
import { KEYS_PANEL_KEY } from '../../board/commands'
import { isEditableTarget } from '../../lib/keys'
import { useSettings } from '../../lib/settings'
import { ModalPanel } from '../ModalPanel'
import { tip } from '../Tooltip'
import { AboutSection } from './AboutSection'
import { AgentsSection } from './AgentsSection'
import { FolderSection, type FolderActions, type FolderSettings } from './FolderSection'
import { GeneralSection } from './GeneralSection'
import { ShortcutsSection } from './ShortcutsSection'
import { VoiceSection } from './VoiceSection'

export type SettingsSection = 'general' | 'voice' | 'agents' | 'folder' | 'shortcuts' | 'about'

const ICON = { size: 16, strokeWidth: 1.75 }

/** The section list, in order; About is pinned at the bottom. */
const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal {...ICON} /> },
  { id: 'voice', label: 'Voice', icon: <Volume2 {...ICON} /> },
  { id: 'agents', label: 'Agents', icon: <Bot {...ICON} /> },
  { id: 'folder', label: 'Folder', icon: <Folder {...ICON} /> },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: <Keyboard {...ICON} /> }
]
const ABOUT = { id: 'about' as const, label: 'About', icon: <Info {...ICON} /> }

interface SettingsDialogProps {
  section: SettingsSection
  onSection(section: SettingsSection): void
  onClose(): void
  folder: FolderSettings | null
  homeDir: string
  folderActions: FolderActions
}

/**
 * The Settings dialog (decision U12): a centred modal over the backdrop (the shared ModalPanel), the section list on
 * the left, the chosen section's rows on the right. App owns whether it is open and at which section (openSettings).
 * Each section shows its own part of main's snapshot (lib/settings.ts) or its own data; no section reads another's state.
 */
export function SettingsDialog({ section, onSection, onClose, folder, homeDir, folderActions }: SettingsDialogProps) {
  const settings = useSettings()

  const navItem = (entry: (typeof SECTIONS)[number]): ReactNode => (
    <button
      key={entry.id}
      className={entry.id === section ? 'menu__item menu__item--current' : 'menu__item'}
      aria-current={entry.id === section ? 'page' : undefined}
      data-section={entry.id}
      onClick={() => onSection(entry.id)}
    >
      <span className="menu__icon">{entry.icon}</span>
      <span className="menu__label">{entry.label}</span>
    </button>
  )

  let body: ReactNode = null
  if (section === 'agents') body = <AgentsSection />
  else if (section === 'folder') body = <FolderSection folder={folder} homeDir={homeDir} actions={folderActions} />
  else if (section === 'shortcuts') body = <ShortcutsSection />
  else if (settings) {
    if (section === 'general') body = <GeneralSection general={settings.general} />
    else if (section === 'voice') body = <VoiceSection voice={settings.voice} />
    else body = <AboutSection about={settings.about} />
  }

  const title = section === 'about' ? ABOUT.label : SECTIONS.find((entry) => entry.id === section)?.label

  // ? closes the dialog on the shortcut list, as it opened it there.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (section !== 'shortcuts' || event.key !== KEYS_PANEL_KEY || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return
    event.preventDefault()
    onClose()
  }

  return (
    <ModalPanel className="menu--split settings-dialog" label="Settings" onClose={onClose} onKeyDown={keyDown}>
      <nav className="menu__nav scroll-area" aria-label="Settings sections">
        {SECTIONS.map(navItem)}
        <div className="menu__nav-end">{navItem(ABOUT)}</div>
      </nav>
      <div className="menu__pane" data-section={section}>
        <header className="menu__header">
          <div className="menu__title">{title}</div>
          <button className="icon-button icon-button--strong" aria-label="Close" {...tip('Close', 'Esc')} onClick={onClose}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="menu__scroll scroll-area">{body}</div>
      </div>
    </ModalPanel>
  )
}
