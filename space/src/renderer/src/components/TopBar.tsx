import { AlertCircle, Check } from 'lucide-react'
import type { AgentServerStatus, GuideOverrides } from '@shared/space-api'
import { AgentPill } from './AgentPill'
import { PerfPill } from './PerfPill'
import { ScenePill } from './ScenePill'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

interface TopBarProps {
  folderName: string | null
  boardName: string | null
  saveStatus: SaveStatus | null
  /** The canvas zoom factor, where 1 is 100%. Null when no board is open. */
  zoom: number | null
  onResetZoom(): void
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

export function TopBar({ folderName, boardName, saveStatus, zoom, onResetZoom, agentStatus, agentActivityAt, guideOverrides, onOpenOverride, showPerformance }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__title">
        {folderName ? (
          <>
            <span className="topbar__crumb">{folderName}</span>
            {boardName && (
              <>
                <span className="topbar__sep">/</span>
                <span className="topbar__board">{boardName}</span>
              </>
            )}
          </>
        ) : (
          <span className="topbar__crumb">Learning Space</span>
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
        {zoom !== null && (
          <button className="zoom" title="Reset zoom to 100% (⌘0)" onClick={onResetZoom}>
            {Math.round(zoom * 100)}%
          </button>
        )}
      </div>
    </header>
  )
}
