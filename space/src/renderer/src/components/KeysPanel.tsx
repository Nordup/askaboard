import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { markFocus, returnFocus } from '../lib/focus'
import { LOCK_KEY, TOOLS } from '../tools'
import { allCommandGroups, KEYS, KEYS_PANEL_KEY, ZOOM_COMMANDS } from '../board/commands'

interface KeyRow {
  label: string
  keys: string
}

/** The panel's sections: the tools from TOOLS, the board commands from commands.ts, then the view keys. */
function sections(): { heading: string; rows: KeyRow[] }[] {
  const tools: KeyRow[] = [
    ...TOOLS.map((tool) => ({ label: tool.label, keys: tool.digit ? `${tool.key} or ${tool.digit}` : tool.key })),
    { label: 'Keep tool', keys: LOCK_KEY }
  ]
  const edit: KeyRow[] = [{ label: 'Undo', keys: KEYS.undo }, { label: 'Redo', keys: KEYS.redo }, ...allCommandGroups().flat()]
  const view: KeyRow[] = [
    { label: 'Zoom in', keys: KEYS.zoomIn },
    { label: 'Zoom out', keys: KEYS.zoomOut },
    ...ZOOM_COMMANDS,
    { label: 'Pan', keys: 'Space + drag' },
    { label: 'Deselect, or back to Select', keys: 'Esc' },
    { label: 'Keyboard shortcuts', keys: KEYS_PANEL_KEY }
  ]
  return [
    { heading: 'Tools', rows: tools },
    { heading: 'Edit', rows: edit },
    { heading: 'View', rows: view }
  ]
}

/**
 * The keys panel (?): every tool with its keys and the board's main commands, in the shared modal panel
 * (`.menu--panel` over a `.backdrop`, as the search panel). Escape, ? or a press outside closes it.
 */
export function KeysPanel({ onClose }: { onClose(): void }) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [opener] = useState(markFocus)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Open: an open menu or popover closes (the backdrop is an outside press for all of them). Close: the focus goes back.
  useLayoutEffect(() => {
    backdropRef.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    panelRef.current?.focus({ preventScroll: true })
    return () => returnFocus(opener)
  }, [opener])

  // While open, no key without ⌘ or Ctrl reaches the board, the tools or the sidebar.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) return
      event.stopPropagation()
      event.preventDefault()
      if (event.key === 'Escape' || (event.key === KEYS_PANEL_KEY && !event.repeat)) onCloseRef.current()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  return createPortal(
    <div
      ref={backdropRef}
      className="backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={panelRef} className="menu menu--panel keys-panel" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1}>
        <div className="menu__title">Keyboard shortcuts</div>
        <div className="menu__scroll menu__columns">
          {sections().map((section) => (
            <section key={section.heading}>
              <div className="menu__heading">{section.heading}</div>
              {section.rows.map((row) => (
                <div key={row.label} className="menu__row">
                  <span className="menu__name">{row.label}</span>
                  <span className="menu__meta menu__meta--mono">{row.keys}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
