import { tip } from './Tooltip'
import { AlertCircle, SquarePen } from 'lucide-react'
import type { AgentServerStatus, GuideOverrides } from '@shared/space-api'
import { AgentPill } from './AgentPill'
import { PerfPill } from './PerfPill'
import { RenameInput } from './RenameInput'
import { ScenePill } from './ScenePill'
import { SidebarToggle } from './SidebarToggle'
import { shortcut } from '../platform'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

interface TopBarProps {
  /** With the sidebar hidden, the top bar starts with the sidebar button and New board (the sidebar's strip holds the button otherwise). */
  sidebarHidden: boolean
  onToggleSidebar(): void
  /** New board; null without a folder. */
  onCreateBoard: (() => void) | null
  folderName: string | null
  boardName: string | null
  /** The open board's name is a rename field (a new board, with the sidebar hidden). */
  renaming: boolean
  onRename(name: string): void
  onCancelRename(): void
  /** Only a failed save shows ("Not saved"); null when no board is open. */
  saveStatus: SaveStatus | null
  agentStatus: AgentServerStatus | null
  /** Time (ms) of the last agent tool call. */
  agentActivityAt: number | null
  guideOverrides: GuideOverrides | null
  onOpenOverride(path: string): void
  /** View > Show performance. */
  showPerformance: boolean
}

export function TopBar(props: TopBarProps) {
  const { sidebarHidden, folderName, boardName, saveStatus, agentStatus, agentActivityAt, guideOverrides, onOpenOverride, showPerformance } = props
  return (
    <header className="topbar">
      <div className="topbar__title">
        {sidebarHidden && (
          <span className="topbar__lead">
            <SidebarToggle hidden onToggle={props.onToggleSidebar} />
            {props.onCreateBoard && (
              <button className="icon-button icon-button--strong icon-button--title" {...tip('New board', shortcut('N'))} aria-label="New board" onClick={props.onCreateBoard}>
                <SquarePen size={16} strokeWidth={1.75} />
              </button>
            )}
          </span>
        )}
        {boardName && props.renaming ? (
          <RenameInput key={boardName} initial={boardName} className="board-row__input topbar__rename" onCommit={props.onRename} onCancel={props.onCancelRename} />
        ) : boardName ? (
          <span className="topbar__board">{boardName}</span>
        ) : (
          <span className="topbar__folder">{folderName ?? 'Learning Space'}</span>
        )}
        {saveStatus && (
          // The live region stays while a board is open; it holds words only when a save failed.
          <span className="save-status" aria-live="polite">
            {saveStatus === 'error' && (
              <>
                <AlertCircle size={12} strokeWidth={2} />
                Not saved
              </>
            )}
          </span>
        )}
      </div>
      <div className="topbar__right">
        {showPerformance && <PerfPill />}
        <ScenePill />
        <AgentPill status={agentStatus} activityAt={agentActivityAt} guideOverrides={guideOverrides} onOpenOverride={onOpenOverride} />
      </div>
    </header>
  )
}
