import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Ellipsis, ExternalLink, Folder, FolderOpen, GraduationCap, LayoutDashboard, Pencil, Plus, Trash } from 'lucide-react'
import type { FileNode, FileTree as FileTreeData, RecentFolder } from '@shared/space-api'
import { FileTree } from './FileTree'
import { Menu, type MenuEntry } from './Menu'

export interface BoardEntry {
  path: string
  name: string
  /** The folder of the board, when it is not the default `boards/` folder. */
  dir: string | null
}

interface SidebarProps {
  folderName: string | null
  folderRoot: string | null
  recent: RecentFolder[]
  boards: BoardEntry[]
  tree: FileTreeData | null
  openBoard: string | null
  previewPath: string | null
  renaming: string | null
  onOpenFolder(): void
  onOpenRecent(path: string): void
  onOpenBoard(path: string): void
  onCreateBoard(): void
  onStartRename(path: string): void
  onRename(path: string, name: string): void
  onCancelRename(): void
  onDeleteBoard(path: string): void
  onReveal(path: string): void
  onOpenFile(node: FileNode): void
  /** Show the setup preview (File > Set Up Folder for Learning…). */
  onSetUpFolder(): void
  /** Open the folder's board guide, .learning-space/guide.md. */
  onEditGuide(): void
}

const ICON = { size: 14, strokeWidth: 1.75 }

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (commit && name && name !== initial) onCommit(name)
    else onCancel()
  }
  return (
    <input
      className="board-row__input"
      value={value}
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

export function Sidebar(props: SidebarProps) {
  const { folderName, folderRoot, recent, boards, tree, openBoard, previewPath, renaming } = props
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // A new folder starts with its top-level folders open.
  useEffect(() => {
    setExpanded(new Set(tree?.nodes.filter((node) => node.kind === 'dir').map((node) => node.path) ?? []))
    // Only when the folder changes, not on every tree refresh.
  }, [folderRoot])

  const folderMenu = (x: number, y: number): void => {
    const others = recent.filter((entry) => entry.path !== folderRoot)
    setMenu({
      x,
      y,
      entries: [
        { label: 'Open Learning Folder…', icon: <FolderOpen {...ICON} />, hint: '⌘O', onSelect: props.onOpenFolder },
        ...(others.length
          ? (['separator', { heading: 'Recent' }] as MenuEntry[]).concat(
              others.map((entry) => ({
                label: entry.name,
                icon: <Folder {...ICON} />,
                onSelect: () => props.onOpenRecent(entry.path)
              }))
            )
          : []),
        ...(folderRoot
          ? ([
              'separator',
              { label: 'Set Up for Learning…', icon: <GraduationCap {...ICON} />, onSelect: props.onSetUpFolder },
              { label: 'Edit Board Guide…', icon: <BookOpen {...ICON} />, onSelect: props.onEditGuide },
              { label: 'Reveal in Finder', icon: <ExternalLink {...ICON} />, onSelect: () => props.onReveal('.') }
            ] as MenuEntry[])
          : [])
      ]
    })
  }

  const boardMenu = (board: BoardEntry, x: number, y: number): void => {
    setMenu({
      x,
      y,
      entries: [
        { label: 'Rename', icon: <Pencil {...ICON} />, onSelect: () => props.onStartRename(board.path) },
        { label: 'Reveal in Finder', icon: <ExternalLink {...ICON} />, onSelect: () => props.onReveal(board.path) },
        'separator',
        { label: 'Move to Trash', icon: <Trash {...ICON} />, danger: true, onSelect: () => props.onDeleteBoard(board.path) }
      ]
    })
  }

  const activePaths = new Set([openBoard, previewPath].filter((path): path is string => !!path))

  return (
    <aside className="sidebar">
      <div className="sidebar__titlebar" />

      <button
        className="folder-header"
        title={folderRoot ?? 'Open a learning folder'}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          folderMenu(rect.left, rect.bottom + 4)
        }}
      >
        <span className="folder-header__icon">
          <Folder size={14} strokeWidth={1.75} />
        </span>
        <span className="folder-header__text">
          <span className={folderName ? 'folder-header__name' : 'folder-header__name folder-header__name--empty'}>
            {folderName ?? 'No folder'}
          </span>
          <span className="folder-header__path">Learning folder</span>
        </span>
        <ChevronDown className="folder-header__chevron" size={14} strokeWidth={1.75} />
      </button>

      <div className="sidebar__scroll">
        <section className="section">
          <header className="section__header">
            <span className="section__title">Boards</span>
            {folderName && (
              <button className="icon-button" title="New board (⌘N)" aria-label="New board" onClick={props.onCreateBoard}>
                <Plus size={14} strokeWidth={2} />
              </button>
            )}
          </header>
          {boards.length === 0 ? (
            <div className="section__empty">
              <LayoutDashboard size={13} strokeWidth={1.75} />
              {folderName ? 'No boards yet' : 'Open a folder first'}
            </div>
          ) : (
            <ul className="board-list">
              {boards.map((board) => (
                <li key={board.path}>
                  {renaming === board.path ? (
                    <div className="board-row board-row--editing">
                      <LayoutDashboard className="board-row__icon" {...ICON} />
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
                        if (event.key === 'Enter') props.onOpenBoard(board.path)
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        boardMenu(board, event.clientX, event.clientY)
                      }}
                    >
                      <LayoutDashboard className="board-row__icon" {...ICON} />
                      <span className="board-row__name">{board.name}</span>
                      {board.dir && <span className="board-row__dir">{board.dir}</span>}
                      <button
                        className="board-row__more icon-button"
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
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section">
          <header className="section__header">
            <span className="section__title">Files</span>
          </header>
          {tree && tree.nodes.length > 0 ? (
            <>
              <FileTree
                nodes={tree.nodes}
                expanded={expanded}
                activePaths={activePaths}
                onToggle={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })
                }
                onOpen={props.onOpenFile}
              />
              {tree.truncated && <div className="section__empty">Some files are not shown (folder too large)</div>}
            </>
          ) : (
            <div className="section__empty">{folderName ? 'This folder is empty' : 'Open a folder to see its files'}</div>
          )}
        </section>
      </div>

      <footer className="sidebar__footer">
        <span>Learning Space</span>
        <span className="mono">v{window.space.version}</span>
      </footer>

      {menu && <Menu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} minWidth={menu.entries.length > 4 ? 220 : 180} />}
    </aside>
  )
}
