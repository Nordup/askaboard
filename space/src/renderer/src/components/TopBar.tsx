import { AlertCircle, Check, SquarePen } from 'lucide-react'
import type { AgentServerStatus, GuideOverrides } from '@shared/space-api'
import { AgentPill } from './AgentPill'
import { PerfPill } from './PerfPill'
import { RenameInput } from './RenameInput'
import { ScenePill } from './ScenePill'
import { SidebarToggle } from './SidebarToggle'
import { shortcut } from '../platform'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

interface TopBarProps {
  /** With the sidebar hidden, the top bar starts with the sidebar button and New board. */
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
  saveStatus: SaveStatus | null
  agentStatus: AgentServerStatus | null
  /** Time (ms) of the last agent tool call. */
  agentActivityAt: number | null
  guideOverrides: GuideOverrides | null
  onOpenOverride(path: string): void
  /** View > Show performance. */
  showPerformance: boolean
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Edited',
  error: 'Not saved'
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
              <button className="icon-button icon-button--strong icon-button--title" title={`New board (${shortcut('N')})`} aria-label="New board" onClick={props.onCreateBoard}>
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
          <span className={`save-status save-status--${saveStatus}`} aria-live="polite">
            {saveStatus === 'saved' && <Check size={12} strokeWidth={2} />}
            {saveStatus === 'error' && <AlertCircle size={12} strokeWidth={2} />}
            {saveStatus === 'saving' || saveStatus === 'unsaved' ? <span className="save-status__dot" /> : null}
            {SAVE_LABEL[saveStatus]}
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
