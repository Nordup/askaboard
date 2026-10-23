import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: ReactNode
  /** Secondary text on the right, for example a path. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect(): void
}

export type MenuEntry = MenuItem | 'separator' | { heading: string }

interface MenuProps {
  /** Viewport position of the menu's top-left corner. */
  x: number
  y: number
  entries: MenuEntry[]
  onClose(): void
  minWidth?: number
}

/** A small popup menu. Closes on outside pointer down, Escape, blur or a choice. */
export function Menu({ x, y, entries, onClose, minWidth = 180 }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [x, y])

  useEffect(() => {
    const down = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
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
  }, [onClose])

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ ...position, minWidth }}>
      {entries.map((entry, index) => {
        if (entry === 'separator') return <div key={index} className="menu__separator" />
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
