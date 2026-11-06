import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { markFocus, returnFocus } from '../lib/focus'

interface ModalPanelProps {
  /** The instance class after `menu menu--panel` (it sets only position and size, design-system.md). */
  className: string
  label: string
  onClose(): void
  /** The element that has the focus while the panel is open (the search field); the panel itself when absent. */
  focusRef?: RefObject<HTMLElement | null>
  /** A press on the panel or the backdrop leaves the focus in focusRef (the search panel: typing goes on). */
  holdFocus?: boolean
  /** Keys in the panel, before Escape closes it (preventDefault keeps it open). */
  onKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void
  children: ReactNode
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The one modal panel (the design system's `.menu--panel` over a `.backdrop`): the search panel and the Settings
 * dialog. At open an open menu or popover closes (the backdrop is an outside press for all of them) and the panel takes
 * the focus; at close the focus goes back as it was (lib/focus.ts). While open no key reaches the board, the tools or
 * the sidebar: keys in the panel stop at it, a key outside it brings the focus back, Tab stays inside, Escape and a
 * press on the backdrop close it.
 */
export function ModalPanel({ className, label, onClose, focusRef, holdFocus = false, onKeyDown, children }: ModalPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [opener] = useState(markFocus)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const focusTarget = (): HTMLElement | null => focusRef?.current ?? panelRef.current

  useLayoutEffect(() => {
    backdropRef.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    focusTarget()?.focus({ preventScroll: true })
    return () => returnFocus(opener)
  }, [opener])

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (panelRef.current?.contains(event.target as Node)) return
      event.stopPropagation()
      if (!event.metaKey && !event.ctrlKey) event.preventDefault()
      if (event.key === 'Escape') onCloseRef.current()
      else focusTarget()?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    event.stopPropagation()
    // A key that ends an input method's composition (Escape drops the candidate) belongs to the field.
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Tab' && panelRef.current) {
      // Tab and Shift+Tab go round the panel's controls.
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null)
      if (!items.length) return
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1
      if ((event.shiftKey && at <= 0) || (!event.shiftKey && (at === -1 || at === items.length - 1))) {
        event.preventDefault()
        items[next].focus()
      }
    }
  }

  return createPortal(
    <div
      ref={backdropRef}
      className="backdrop"
      onMouseDown={holdFocus ? (event) => event.preventDefault() : undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`menu menu--panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={
          holdFocus
            ? (event) => {
                if (event.target !== focusRef?.current) event.preventDefault()
              }
            : undefined
        }
        onKeyDown={keyDown}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
