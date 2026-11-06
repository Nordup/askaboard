import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type CSSProperties } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useMenuDismiss } from '../lib/dismiss'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectProps<T extends string> {
  value: T
  options: readonly SelectOption<T>[]
  onChange(value: T): void
  /** The accessible name (the setting's name). */
  label: string
  disabled?: boolean
}

/** From the trigger to the list, and the least room the list keeps to the window's edges (px, as tokens.css says). */
const LIST_GAP = 4
const WINDOW_MARGIN = 8
/** Typed letters find an option while they come within this time of each other. */
const TYPE_AHEAD_MS = 600

/**
 * The app's own dropdown (decision U14), in place of a native select: a `.menu__select` trigger and, while open, a
 * `.menu--select` list of `.menu__option` rows under it (right-aligned to it; above it when there is no room below).
 * The list is rendered inside the trigger's root, not in a portal, so it stays inside a modal panel: its keys reach it
 * before the panel's own (Escape closes the list only), and a press on it is no outside press. Escape and a press
 * outside close it through the shared menu plumbing (lib/dismiss.ts); the focus goes back as it was (lib/focus.ts).
 */
export function Select<T extends string>({ value, options, onChange, label, disabled = false }: SelectProps<T>) {
  const id = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActiveState] = useState(0)
  /** The active row as the keys last left it: Enter reads this, never a render's copy that a newer key or move outdated. */
  const activeRef = useRef(0)
  const setActive = (index: number): void => {
    activeRef.current = index
    setActiveState(index)
  }
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })
  const typed = useRef({ text: '', at: 0 })
  const close = useCallback(() => setOpen(false), [])
  const dismiss = useMenuDismiss(open, rootRef, close)

  const chosen = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  const show = (): void => {
    if (disabled || !options.length) return
    setActive(chosen)
    setPlace({ visibility: 'hidden' })
    setOpen(true)
  }

  // Place the list at the trigger, inside the window: under it, else above it, else where it has the most room
  // (it then scrolls inside); the chosen option in view. A scroll or a resize under an open list closes it.
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const list = listRef.current
    if (!open || !trigger || !list) return
    const at = trigger.getBoundingClientRect()
    // Its height within the CSS max-height (a long list scrolls).
    const height = list.offsetHeight
    const below = window.innerHeight - WINDOW_MARGIN - (at.bottom + LIST_GAP)
    const above = at.top - LIST_GAP - WINDOW_MARGIN
    const up = height > below && above > below
    const room = up ? above : below
    const width = Math.max(list.offsetWidth, at.width)
    setPlace({
      left: Math.max(WINDOW_MARGIN, Math.min(at.right - width, window.innerWidth - WINDOW_MARGIN - width)),
      ...(up ? { bottom: window.innerHeight - at.top + LIST_GAP } : { top: at.bottom + LIST_GAP }),
      minWidth: `max(var(--select-list-min-width), ${at.width}px)`,
      maxHeight: `min(var(--select-list-max-height), ${Math.floor(room)}px)`
    })
  }, [open])

  useEffect(() => {
    const list = listRef.current
    if (!open || !list || place.visibility === 'hidden') return
    list.focus({ preventScroll: true })
    list.querySelector<HTMLElement>(`[data-index="${chosen}"]`)?.scrollIntoView({ block: 'nearest' })
    const away = (event: Event): void => {
      if (!list.contains(event.target as Node)) close()
    }
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
    // Only when the list is placed: a change of the chosen option while open does not scroll it again.
  }, [open, place.visibility, close])

  const moveTo = (index: number): void => {
    const next = Math.max(0, Math.min(options.length - 1, index))
    setActive(next)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const choose = (index: number): void => {
    dismiss()
    const option = options[index]
    if (option && option.value !== value) onChange(option.value)
  }

  /** Typed letters go to the next option whose label starts with them (one letter again: the next such option). */
  const findTyped = (letter: string): void => {
    const now = performance.now()
    const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + letter.toLowerCase() : letter.toLowerCase()
    typed.current = { text, at: now }
    const same = text.length > 1 && [...text].every((char) => char === text[0])
    const prefix = same ? text[0] : text
    const from = text.length === 1 || same ? activeRef.current + 1 : activeRef.current
    for (let step = 0; step < options.length; step++) {
      const index = (from + step) % options.length
      if (options[index].label.toLowerCase().startsWith(prefix)) return moveTo(index)
    }
  }

  // The keys that open the list act on keydown (also Enter and Space: a button's own click would wait for the key's
  // up or need its character); preventDefault keeps that click from closing the list again.
  const triggerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    if (!open) show()
  }

  const listKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    let handled = true
    const at = activeRef.current
    if (event.key === 'ArrowDown') moveTo(at + 1)
    else if (event.key === 'ArrowUp') moveTo(at - 1)
    else if (event.key === 'Home' || event.key === 'PageUp') moveTo(0)
    else if (event.key === 'End' || event.key === 'PageDown') moveTo(options.length - 1)
    else if (event.key === 'Enter' || event.key === ' ') choose(at)
    else if (event.key === 'Escape' || event.key === 'Tab') dismiss()
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) findTyped(event.key)
    else handled = false
    if (!handled) return
    event.preventDefault()
    // The list's keys stay with it: the modal panel does not see them (Escape there would close the dialog).
    event.stopPropagation()
  }

  return (
    <span ref={rootRef} className="menu__select-root">
      <button
        ref={triggerRef}
        className="menu__select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? dismiss() : show())}
        onKeyDown={triggerKey}
      >
        <span className="menu__select-value">{options[chosen]?.label ?? ''}</span>
        <ChevronDown className="menu__select-chevron" size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          id={`${id}-list`}
          className="menu menu--select scroll-area"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          style={place}
          onKeyDown={listKey}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              data-index={index}
              className="menu__option"
              role="option"
              aria-selected={index === chosen}
              data-active={index === active ? '' : undefined}
              onPointerMove={(event) => {
                // Only a real move of the pointer moves the active row: Chromium also sends a move with no movement
                // when the rows open or change under a still pointer, and that must not undo the keys' choice.
                if (!event.movementX && !event.movementY) return
                if (index !== activeRef.current) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              <span className="menu__option-label">{option.label}</span>
              {index === chosen && <Check className="menu__option-check" size={14} strokeWidth={2} aria-hidden="true" />}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
