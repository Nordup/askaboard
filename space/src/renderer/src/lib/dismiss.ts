import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { markFocus, returnFocus, type FocusMark } from './focus'

/**
 * A menu that opens from a button (the top bar's pills, a select): Escape and a click outside the root close it;
 * Escape gives the focus back as it was (lib/focus.ts). The hook answers `dismiss`, which closes the menu and gives the
 * focus back the same way (a choice in a select). `close` must keep its identity while the menu is open.
 */
export function useMenuDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: () => void): () => void {
  useDragStripsOff(open)
  const openerRef = useRef<FocusMark | null>(null)
  useEffect(() => {
    if (!open) return
    const opener = markFocus()
    openerRef.current = opener
    const down = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        returnFocus(opener)
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, rootRef, close])
  return useCallback(() => {
    close()
    if (openerRef.current) returnFocus(openerRef.current)
  }, [close])
}

/** Open menus: the top bar and the sidebar strip stop dragging the window while one is open (app.css, :root[data-menu-open]).
 *  On macOS a press in a drag region goes to the window drag, so the page gets no pointerdown and the menu would stay open. */
let openMenus = 0

export function useDragStripsOff(open: boolean): void {
  useEffect(() => {
    if (!open) return
    openMenus += 1
    document.documentElement.setAttribute('data-menu-open', '')
    return () => {
      openMenus -= 1
      if (openMenus === 0) document.documentElement.removeAttribute('data-menu-open')
    }
  }, [open])
}
