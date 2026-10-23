import { FileText, Folder, LayoutDashboard, Plus } from 'lucide-react'

interface SidebarProps {
  folderName: string | null
}

export function Sidebar({ folderName }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__titlebar" />

      <div className="folder-header">
        <span className="folder-header__icon">
          <Folder size={14} strokeWidth={1.75} />
        </span>
        <span className="folder-header__text">
          <span className={folderName ? 'folder-header__name' : 'folder-header__name folder-header__name--empty'}>
            {folderName ?? 'No folder'}
          </span>
          <span className="folder-header__path">Learning folder</span>
        </span>
      </div>

      <div className="sidebar__scroll">
        <section className="section">
          <header className="section__header">
            <span className="section__title">Boards</span>
            <button className="icon-button" title="New board" aria-label="New board">
              <Plus size={14} strokeWidth={2} />
            </button>
          </header>
          <div className="section__empty">
            <LayoutDashboard size={13} strokeWidth={1.75} />
            No boards yet
          </div>
        </section>

        <section className="section">
          <header className="section__header">
            <span className="section__title">Files</span>
          </header>
          <div className="section__empty">
            <FileText size={13} strokeWidth={1.75} />
            Open a folder to see its files
          </div>
        </section>
      </div>

      <footer className="sidebar__footer">
        <span>Learning Space</span>
        <span className="mono">v{window.space.version}</span>
      </footer>
    </aside>
  )
}
