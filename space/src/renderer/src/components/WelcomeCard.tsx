import { FolderOpen, PenLine } from 'lucide-react'

export function WelcomeCard() {
  const isMac = window.space.platform === 'darwin'

  return (
    <div className="welcome">
      <div className="welcome__card">
        <div className="welcome__mark">
          <PenLine size={20} strokeWidth={1.75} />
        </div>
        <h1 className="welcome__title">Learning Space</h1>
        <p className="welcome__lede">A shared canvas for you and your AI agent.</p>

        <button className="button-primary" onClick={() => console.log('open folder: arrives in step 1')}>
          <FolderOpen size={15} strokeWidth={2} />
          Open learning folder…
          <span className="kbd">{isMac ? '⌘O' : 'Ctrl O'}</span>
        </button>

        <div className="welcome__recent">
          <div className="welcome__recent-title">Recent</div>
          <div className="welcome__recent-empty">No recent folders</div>
        </div>
      </div>
    </div>
  )
}
