import { Check } from 'lucide-react'
import { homePath, shortPath } from '../../lib/paths'
import { revealLabel, shortcut } from '../../platform'
import { SettingRow } from './parts'

/** The open learning folder as Settings > Folder shows it; null with no folder open. */
export interface FolderSettings {
  name: string
  root: string
  /** AGENTS.md is at its root (main/setup.ts SETUP_MARKER). */
  setUp: boolean
}

/** The folder actions: App's own handlers, the same ones the folder menu, File and the setup flyout run. */
export interface FolderActions {
  onOpenFolder(): void
  onReveal(): void
  onEditGuide(): void
  onSetUp(): void
}

/** Settings > Folder: where the boards are, and the folder's actions. With no folder open: "Open a folder" only. */
export function FolderSection({ folder, homeDir, actions }: { folder: FolderSettings | null; homeDir: string; actions: FolderActions }) {
  if (!folder)
    return (
      <SettingRow name="No folder open" description="A learning folder holds your boards">
        <button className="btn-sm" onClick={actions.onOpenFolder}>
          Open a folder
        </button>
      </SettingRow>
    )
  return (
    <>
      <SettingRow name={folder.name} description={shortPath(homePath(folder.root, homeDir))}>
        <button className="btn-sm" onClick={actions.onReveal}>
          {revealLabel}
        </button>
      </SettingRow>
      <SettingRow name="Change folder" description={`Open another learning folder (${shortcut('O')})`}>
        <button className="btn-sm" onClick={actions.onOpenFolder}>
          Change folder…
        </button>
      </SettingRow>
      <SettingRow name="Board guide" description="How agents draw on boards in this folder (.learning-space/guide.md)">
        <button className="btn-sm" onClick={actions.onEditGuide}>
          Edit
        </button>
      </SettingRow>
      <SettingRow name="Set up for learning" description="AGENTS.md and the board guide tell agents how to teach here">
        {folder.setUp ? (
          <span className="menu__status">
            <Check size={13} strokeWidth={2.25} />
            Set up
          </span>
        ) : (
          <button className="btn-sm" onClick={actions.onSetUp}>
            Set up…
          </button>
        )}
      </SettingRow>
    </>
  )
}
