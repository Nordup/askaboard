import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { markFocus, returnFocus } from '../lib/focus'

export interface MenuItem {
  label: string
  icon?: ReactNode
  /** Secondary text on the right, for example a path. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect(): void
}

/** A row, a hairline, a small heading, or a quiet path line at the top (.menu__path: `path` shows, `full` is its tooltip). */
export type MenuEntry = MenuItem | 'separator' | { heading: string } | { path: string; full: string }

interface MenuProps {
  /** Viewport position of the menu's top-left corner; with `above`, of its bottom-left corner. */
  x: number
  y: number
  /** The menu opens upward from y (an anchor near the bottom of the window, as the sidebar footer). */
  above?: boolean
  entries: MenuEntry[]
  onClose(): void
  minWidth?: number
  /** An instance class that sets the menu's width only, for example `folder-menu`. */
  className?: string
  /** The button that opens the menu and closes it again: a press on it is not an outside press. */
  toggle?: HTMLElement | null
}

/** A small popup menu. Closes on outside pointer down, Escape, blur or a choice; Escape gives the focus back as it was (lib/focus.ts). */
export function Menu({ x, y, above = false, entries, onClose, minWidth = 180, className, toggle }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Hidden until it is measured, so a menu that opens upward never shows a frame at the wrong place.
  const [position, setPosition] = useState<{ left: number; top: number; visibility?: 'hidden' }>({ left: x, top: y, visibility: 'hidden' })
  const [opener] = useState(markFocus)

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const top = above ? y - rect.height : y
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))
    })
  }, [x, y, above, entries])

  useEffect(() => {
    const down = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current && !ref.current.contains(target) && !toggle?.contains(target)) onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        returnFocus(opener)
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, toggle, opener])

  return createPortal(
    <div ref={ref} className={className ? `menu ${className}` : 'menu'} role="menu" style={{ ...position, minWidth }}>
      {entries.map((entry, index) => {
        if (entry === 'separator') return <div key={index} className="menu__separator" />
        if ('path' in entry)
          return (
            <div key={index} className="menu__path" title={entry.full}>
              {entry.path}
            </div>
          )
        if ('heading' in entry)
          return (
            <div key={index} className="menu__heading">
              {entry.heading}
            </div>
          )
        return (
          <button
            key={index}
            role="menuitem"
            className={entry.danger ? 'menu__item menu__item--danger' : 'menu__item'}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.icon && <span className="menu__icon">{entry.icon}</span>}
            <span className="menu__label">{entry.label}</span>
            {entry.hint && <span className="menu__hint">{entry.hint}</span>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
