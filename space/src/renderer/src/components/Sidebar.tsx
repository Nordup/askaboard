import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronsUpDown, Ellipsis, ExternalLink, Folder, FolderOpen, GraduationCap, LayoutDashboard, Pencil, Search, SquarePen, Trash } from 'lucide-react'
import { shortAgo } from '@shared/board-digest'
import type { BoardListEntry, GuideOverrides, RecentFolder } from '@shared/space-api'
import { GuideOverrideNote } from './GuideOverrideNote'
import { Menu, type MenuEntry } from './Menu'
import { RenameInput } from './RenameInput'
import { SetupMenu } from './SetupMenu'
import { SidebarToggle } from './SidebarToggle'
import { revealLabel, savedOnLabel, shortcut } from '../platform'

interface SidebarProps {
  /** View > Hide Sidebar: the sidebar stays mounted (its setup flyout can still open) but takes no space. */
  hidden: boolean
  onToggleSidebar(): void
  folderName: string | null
  folderRoot: string | null
  /** The learner's home folder, so the folder menu shows the path as `~/…`. */
  homeDir: string
  recent: RecentFolder[]
  /** Newest edit first (main/folder.ts boardList). */
  boards: BoardListEntry[]
  openBoard: string | null
  renaming: string | null
  onOpenFolder(): void
  onOpenRecent(path: string): void
  onOpenBoard(path: string): void
  onCreateBoard(): void
  /** The "Search boards" row (the search panel). */
  onSearch(): void
  onStartRename(path: string): void
  onRename(path: string, name: string): void
  onCancelRename(): void
  onDeleteBoard(path: string): void
  onReveal(path: string): void
  /** Show the "Set up for learning" row: the folder is not set up and the offer is not dismissed. */
  setupOffer: boolean
  /** The setup menu is open. */
  setupOpen: boolean
  /** Changes when the folder changes on disk, so the setup list reloads. */
  setupVersion: number
  /** Open the setup menu (the row, File > Set Up Folder for Learning…). */
  onSetUpFolder(): void
  onCloseSetup(): void
  onApplySetup(): Promise<void>
  onDontAskSetup(): void
  /** Open the folder's board guide, .learning-space/guide.md. */
  onEditGuide(): void
  /** The folder's guide and instructions overrides, shown under the rows. */
  guideOverrides: GuideOverrides | null
  /** Open an override file (the same flow as Edit Board Guide…). */
  onOpenOverride(path: string): void
}

const ICON = { size: 14, strokeWidth: 1.75 }
/** The list shows this many boards until "Show N more". */
const COLLAPSED_BOARDS = 8
const MINUTE_MS = 60_000
const ROW_ICON = { size: 16, strokeWidth: 1.75 }

/** The path with `~` for the home folder. */
function homePath(path: string, home: string): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest === '') return '~'
  return rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : path
}

export function Sidebar(props: SidebarProps) {
  const { hidden, folderName, folderRoot, recent, boards, openBoard, renaming } = props
  const [menu, setMenu] = useState<{ x: number; y: number; above: boolean; entries: MenuEntry[]; className?: string } | null>(null)
  const footerRef = useRef<HTMLButtonElement>(null)
  const setupRowRef = useRef<HTMLButtonElement>(null)

  /** "Show N more" was clicked: for the session of this folder. */
  const [expanded, setExpanded] = useState(false)
  /** The clock of the row times: one tick a minute. */
  const [now, setNow] = useState(() => Date.now())

  // A menu belongs to the sidebar: it closes when the sidebar hides or the folder changes.
  useEffect(() => setMenu(null), [hidden, folderRoot])
  useEffect(() => setExpanded(false), [folderRoot])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])

  // Collapsed: the first boards, and also the open board and a board in rename when they are further down.
  const collapsible = boards.length > COLLAPSED_BOARDS
  const shown = !collapsible || expanded ? boards : boards.filter((board, index) => index < COLLAPSED_BOARDS || board.path === openBoard || board.path === renaming)
  const hiddenCount = boards.length - shown.length

  const folderMenu = (anchor: HTMLElement): void => {
    if (!folderRoot) return
    // Above the footer's hairline, left edge with the row.
    const rect = anchor.getBoundingClientRect()
    const footerTop = anchor.closest('.sidebar__footer')?.getBoundingClientRect().top ?? rect.top
    const others = recent.filter((entry) => entry.path !== folderRoot)
    setMenu({
      x: rect.left,
      y: footerTop - 4,
      above: true,
      className: 'folder-menu',
      entries: [
        { title: folderName ?? '' },
        { lede: homePath(folderRoot, props.homeDir) },
        { lede: 'Your boards are files in this folder.' },
        { label: revealLabel, icon: <ExternalLink {...ICON} />, onSelect: () => props.onReveal('.') },
        { label: 'Open Learning Folder…', icon: <FolderOpen {...ICON} />, hint: shortcut('O'), onSelect: props.onOpenFolder },
        { label: 'Edit Board Guide…', icon: <BookOpen {...ICON} />, onSelect: props.onEditGuide },
        ...(others.length
          ? (['separator', { heading: 'Recent' }] as MenuEntry[]).concat(
              others.map((entry) => ({
                label: entry.name,
                icon: <Folder {...ICON} />,
                onSelect: () => props.onOpenRecent(entry.path)
              }))
            )
          : [])
      ]
    })
  }

  const boardMenu = (board: BoardListEntry, x: number, y: number): void => {
    setMenu({
      x,
      y,
      above: false,
      entries: [
        { label: 'Rename', icon: <Pencil {...ICON} />, onSelect: () => props.onStartRename(board.path) },
        { label: revealLabel, icon: <ExternalLink {...ICON} />, onSelect: () => props.onReveal(board.path) },
        'separator',
        { label: 'Move to Trash', icon: <Trash {...ICON} />, danger: true, onSelect: () => props.onDeleteBoard(board.path) }
      ]
    })
  }

  return (
    <aside className="sidebar" hidden={hidden}>
      <div className="sidebar__strip">
        <SidebarToggle hidden={false} onToggle={props.onToggleSidebar} />
      </div>

      {folderRoot && (
        <nav className="sidebar__actions">
          <button className="board-row board-row--action" onClick={props.onCreateBoard}>
            <SquarePen className="board-row__icon" {...ROW_ICON} />
            <span className="board-row__name">New board</span>
            <span className="board-row__hint">{shortcut('N')}</span>
          </button>
          <button className="board-row board-row--action" onClick={props.onSearch}>
            <Search className="board-row__icon" {...ROW_ICON} />
            <span className="board-row__name">Search boards</span>
            <span className="board-row__hint">{shortcut('K')}</span>
          </button>
          {props.setupOffer && (
            <button
              ref={setupRowRef}
              className={props.setupOpen ? 'board-row board-row--action setup-row board-row--active' : 'board-row board-row--action setup-row'}
              aria-expanded={props.setupOpen}
              onClick={() => (props.setupOpen ? props.onCloseSetup() : props.onSetUpFolder())}
            >
              <GraduationCap className="setup-row__icon" {...ROW_ICON} />
              <span className="board-row__name">Set up for learning</span>
              <span className="setup-row__dot" />
            </button>
          )}
          <GuideOverrideNote className="folder-overrides" overrides={props.guideOverrides} onOpen={props.onOpenOverride} />
        </nav>
      )}
      {folderRoot && props.setupOpen && (
        <SetupMenu
          anchor={props.setupOffer ? setupRowRef.current : footerRef.current}
          anchorToggles={props.setupOffer}
          version={props.setupVersion}
          onSetUp={props.onApplySetup}
          onClose={props.onCloseSetup}
          onDontAsk={props.onDontAskSetup}
        />
      )}

      <div className="sidebar__scroll">
        <section className="section">
          <header className="section__header">
            <span className="section__title">Boards</span>
          </header>
          {!folderName ? null : boards.length === 0 ? (
            <div className="section__empty">
              <LayoutDashboard size={13} strokeWidth={1.75} />
              No boards yet
            </div>
          ) : (
            <ul className="board-list">
              {shown.map((board) => (
                <li key={board.path}>
                  {renaming === board.path ? (
                    <div className="board-row board-row--editing">
                      <RenameInput
                        initial={board.name}
                        onCommit={(name) => props.onRename(board.path, name)}
                        onCancel={props.onCancelRename}
                      />
                    </div>
                  ) : (
                    <div
                      className={board.path === openBoard ? 'board-row board-row--active' : 'board-row'}
                      role="button"
                      tabIndex={0}
                      title={board.path}
                      onClick={() => props.onOpenBoard(board.path)}
                      onDoubleClick={() => props.onStartRename(board.path)}
                      onKeyDown={(event) => {
                        // Enter on the row; Enter on its ellipsis button opens the menu only.
                        if (event.key === 'Enter' && event.target === event.currentTarget) props.onOpenBoard(board.path)
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        boardMenu(board, event.clientX, event.clientY)
                      }}
                    >
                      <span className="board-row__name">{board.name}</span>
                      {board.dir && <span className="board-row__dir">{board.dir}</span>}
                      <span className="board-row__end">
                        <span className="board-row__time">{shortAgo(board.editedAt, now)}</span>
                        <button
                          className="board-row__more"
                          aria-label={`${board.name} actions`}
                          onClick={(event) => {
                            event.stopPropagation()
                            const rect = event.currentTarget.getBoundingClientRect()
                            boardMenu(board, rect.left, rect.bottom + 4)
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          <Ellipsis size={14} strokeWidth={2} />
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              ))}
              {collapsible && (hiddenCount > 0 || expanded) && (
                <li>
                  <button className="board-row board-row--action board-row--quiet" onClick={() => setExpanded(!expanded)}>
                    <span className="board-row__name">{expanded ? 'Show less' : `Show ${hiddenCount} more`}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      <footer className="sidebar__footer">
        <button
          ref={footerRef}
          className="folder-row"
          title={folderRoot ?? undefined}
          aria-haspopup={folderRoot ? 'menu' : undefined}
          aria-expanded={folderRoot ? menu?.className === 'folder-menu' : undefined}
          onClick={(event) => {
            if (!folderRoot) props.onOpenFolder()
            else if (menu?.className === 'folder-menu') setMenu(null)
            else folderMenu(event.currentTarget)
          }}
        >
          <Folder className="folder-row__icon" {...ROW_ICON} />
          {folderRoot ? (
            <>
              <span className="folder-row__text">
                <span className="folder-row__name">{folderName}</span>
                <span className="folder-row__sub">{savedOnLabel}</span>
              </span>
              <ChevronsUpDown className="folder-row__chevron" {...ICON} />
            </>
          ) : (
            <span className="folder-row__text">
              <span className="folder-row__name">Open a folder</span>
            </span>
          )}
        </button>
      </footer>

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          above={menu.above}
          entries={menu.entries}
          className={menu.className}
          toggle={menu.className === 'folder-menu' ? footerRef.current : null}
          onClose={() => setMenu(null)}
          minWidth={menu.entries.length > 4 ? 220 : 180}
        />
      )}
    </aside>
  )
}
