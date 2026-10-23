interface TopBarProps {
  boardTitle: string
  /** The canvas zoom factor, where 1 is 100%. */
  zoom: number
}

export function TopBar({ boardTitle, zoom }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__title">
        <span className="topbar__crumb">Boards</span>
        <span className="topbar__sep">/</span>
        <span className="topbar__board">{boardTitle}</span>
      </div>
      <div className="topbar__right">
        <button className="pill" title="Connect an agent (step 2)">
          <span className="status-dot" />
          No agent connected
        </button>
        <button className="zoom" title="Zoom">
          {Math.round(zoom * 100)}%
        </button>
      </div>
    </header>
  )
}
