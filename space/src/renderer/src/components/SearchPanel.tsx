import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { FolderOpen, LayoutDashboard, Search, SquarePen } from 'lucide-react'
import { sanitizeBoardName } from '@shared/board-format'
import { shortAgo } from '@shared/board-digest'
import type { BoardListEntry } from '@shared/space-api'
import { openFolderLabel, shortcut } from '../platform'
import { ModalPanel } from './ModalPanel'

interface SearchPanelProps {
  /** Newest edit first (main/folder.ts boardList). */
  boards: BoardListEntry[]
  onClose(): void
  onOpenBoard(path: string): void
  /** New board: the sidebar row's action (an Untitled board and its rename step). */
  onNewBoard(): void
  /** `New board "…"`: a board with this name, opened, no rename step. */
  onCreateNamed(name: string): void
  onOpenFolder(): void
}

/** The empty field shows this many recent boards; typed text shows up to MAX_MATCHES. */
const RECENT_BOARDS = 8
const MAX_MATCHES = 50
const ROW_ICON = { size: 16, strokeWidth: 1.75 }

type Row =
  | { kind: 'action'; label: string; icon: ReactNode; hint: string; run(): void }
  | { kind: 'board'; board: BoardListEntry; match: { at: number; length: number } | null }
  | { kind: 'create'; name: string }

/** What the panel shows: the headings sit before the row with that index. */
interface View {
  rows: Row[]
  headings: Map<number, string>
  /** Typed text with no board: the line above the rows. */
  noMatch: string | null
}

/** The boards whose name contains the text (case-insensitive): names that start with it first, then by edit time (the list's order). */
function matchBoards(boards: BoardListEntry[], text: string): Row[] {
  const needle = text.toLowerCase()
  const starts: Row[] = []
  const contains: Row[] = []
  for (const board of boards) {
    const lower = board.name.toLowerCase()
    const at = lower.indexOf(needle)
    if (at < 0) continue
    // A lower-case form of another length (rare letters) has no place to mark in the name.
    const match = lower.length === board.name.length ? { at, length: needle.length } : null
    ;(at === 0 ? starts : contains).push({ kind: 'board', board, match })
  }
  return starts.concat(contains).slice(0, MAX_MATCHES)
}

/**
 * The search panel (decision U7, left-panel plan section 6): a modal panel over the whole window,
 * opened from the sidebar's "Search boards" row and File > Search Boards… (⌘K). App mounts it
 * while it is open. Focus stays in the field; the keys move the selection and run its row; a
 * close gives the focus back as it was (the shared ModalPanel, lib/focus.ts: no ring when the pointer opened the panel).
 */
export function SearchPanel({ boards, onClose, onOpenBoard, onNewBoard, onCreateNamed, onOpenFolder }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [now] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** The last pointer place over the rows: a mouse move at the same place (Chromium sends one after a scroll) moves no selection. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const text = query.trim()
  const view = useMemo((): View => {
    if (!text) {
      const rows: Row[] = [
        { kind: 'action', label: 'New board', icon: <SquarePen {...ROW_ICON} />, hint: shortcut('N'), run: onNewBoard },
        { kind: 'action', label: openFolderLabel, icon: <FolderOpen {...ROW_ICON} />, hint: shortcut('O'), run: onOpenFolder }
      ]
      const headings = new Map([[0, 'Actions']])
      if (boards.length) headings.set(rows.length, 'Recent boards')
      for (const board of boards.slice(0, RECENT_BOARDS)) rows.push({ kind: 'board', board, match: null })
      return { rows, headings, noMatch: null }
    }
    const rows = matchBoards(boards, text)
    if (rows.length) return { rows, headings: new Map(), noMatch: null }
    // The name main gives the file; a text that keeps no name (only dots, say) offers no row.
    const name = sanitizeBoardName(text)
    return { rows: name ? [{ kind: 'create', name }] : [], headings: new Map(), noMatch: text }
  }, [text, boards, onNewBoard, onOpenFolder])

  const { rows } = view
  // The list can change while the panel is open (an agent's edit): the selection stays in it.
  const current = Math.min(selected, rows.length - 1)

  // The selected row stays in view; the first row brings the top (its heading) back too. Only a new selection or a new
  // text moves the scroll: a list that arrives while the panel is open (an agent's edit, a save) keeps the learner's scroll.
  useLayoutEffect(() => {
    if (current <= 0) scrollRef.current?.scrollTo({ top: 0 })
    else rowRefs.current[current]?.scrollIntoView({ block: 'nearest' })
  }, [current, text])

  const run = (row: Row): void => {
    // The panel closes first (and the focus goes back), then the row's action runs: a new board's rename field, the folder dialog.
    flushSync(onClose)
    if (row.kind === 'action') row.run()
    else if (row.kind === 'board') onOpenBoard(row.board.path)
    else onCreateNamed(row.name)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // An IME composition owns its keys (Enter picks the candidate, Escape drops it).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (!rows.length) return
      setSelected(Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat && rows[current]) run(rows[current])
    }
  }

  const label = (row: Row): ReactNode => {
    if (row.kind === 'action') return row.label
    if (row.kind === 'create') return `New board “${row.name}”`
    const { name } = row.board
    if (!row.match) return name
    const { at, length } = row.match
    return (
      <>
        {name.slice(0, at)}
        <mark className="menu__match">{name.slice(at, at + length)}</mark>
        {name.slice(at + length)}
      </>
    )
  }

  rowRefs.current.length = rows.length
  // The shared modal panel: the field keeps the focus (a press on a row, the panel or the backdrop does not take it).
  return (
    <ModalPanel className="search-panel" label="Search boards" onClose={onClose} focusRef={inputRef} holdFocus>
        <div className="menu__field">
          <Search size={17} strokeWidth={1.75} />
          <input
            ref={inputRef}
            className="menu__input"
            value={query}
            placeholder="Search boards"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded
            aria-controls="search-panel-list"
            aria-activedescendant={rows.length ? `search-panel-row-${current}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {(rows.length > 0 || view.noMatch !== null) && (
          <div ref={scrollRef} className="menu__scroll scroll-area" id="search-panel-list" role="listbox">
            {view.noMatch !== null && (
              <div className="menu__line">
                <span className="menu__line-text">No boards match “{view.noMatch}”</span>
              </div>
            )}
            {rows.map((row, index) => (
              <div key={row.kind === 'board' ? row.board.path : `${row.kind}:${index}`} role="presentation">
                {view.headings.has(index) && <div className="menu__heading">{view.headings.get(index)}</div>}
                <button
                  ref={(element) => {
                    rowRefs.current[index] = element
                  }}
                  id={`search-panel-row-${index}`}
                  className={index === current ? 'menu__item menu__item--current' : 'menu__item'}
                  role="option"
                  aria-selected={index === current}
                  tabIndex={-1}
                  onMouseMove={(event) => {
                    const last = pointer.current
                    pointer.current = { x: event.clientX, y: event.clientY }
                    // The first move only records the place: the pointer may sit where the panel opened.
                    if (!last || (last.x === event.clientX && last.y === event.clientY)) return
                    if (index !== current) setSelected(index)
                  }}
                  onClick={() => run(row)}
                >
                  <span className="menu__icon">{row.kind === 'board' ? <LayoutDashboard {...ROW_ICON} /> : row.kind === 'create' ? <SquarePen {...ROW_ICON} /> : row.icon}</span>
                  <span className="menu__label">{label(row)}</span>
                  {row.kind === 'board' && row.board.dir && <span className="menu__sub">{row.board.dir}</span>}
                  {row.kind === 'board' ? <span className="menu__hint">{shortAgo(row.board.editedAt, now)}</span> : row.kind === 'action' ? <span className="menu__hint">{row.hint}</span> : null}
                </button>
              </div>
            ))}
          </div>
        )}
    </ModalPanel>
  )
}
