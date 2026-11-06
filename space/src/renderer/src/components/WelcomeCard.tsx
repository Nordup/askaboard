import { Folder, FolderOpen, PenLine } from 'lucide-react'
import type { RecentFolder } from '@shared/space-api'
import { shortcut } from '../platform'

interface WelcomeCardProps {
  recent: RecentFolder[]
  onOpenFolder(): void
  onOpenRecent(path: string): void
}

export function WelcomeCard({ recent, onOpenFolder, onOpenRecent }: WelcomeCardProps) {
  return (
    <div className="overlay-center">
      <div className="welcome__card">
        <div className="welcome__mark">
          <PenLine size={20} strokeWidth={1.75} />
        </div>
        <h1 className="welcome__title">Learning Space</h1>
        <p className="welcome__lede">A shared canvas for you and your AI agent.</p>

        <button className="button-primary" onClick={onOpenFolder}>
          <FolderOpen size={15} strokeWidth={2} />
          Open learning folder…
          <span className="kbd">{shortcut('O')}</span>
        </button>

        <div className="welcome__recent">
          <div className="welcome__recent-title">Recent</div>
          {recent.length === 0 ? (
            <div className="welcome__recent-empty">No recent folders</div>
          ) : (
            <ul className="recent-list">
              {recent.map((entry) => (
                <li key={entry.path}>
                  <button className="recent-row" onClick={() => onOpenRecent(entry.path)}>
                    <Folder size={14} strokeWidth={1.75} />
                    <span className="recent-row__name">{entry.name}</span>
                    <span className="recent-row__path">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
