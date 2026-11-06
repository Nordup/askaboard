import { useEffect, type RefObject } from 'react'
import { markFocus, returnFocus } from './focus'

/** The top-bar pills' menus: Escape and a click outside the root close an open menu; Escape gives the focus back as it was (lib/focus.ts). */
export function useMenuDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const opener = markFocus()
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
}
