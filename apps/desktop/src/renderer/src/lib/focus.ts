/**
 * Every menu and panel gives the focus back as it found it (left-panel plan, section 6): to the element that had it,
 * with the focus ring only when that element showed one at open time (the keyboard reached it). Chromium otherwise
 * rings the element after any key in the menu (Escape, typing in the search field), also when the pointer opened it.
 */
export interface FocusMark {
  /** The element that had the focus when the menu opened; null for the page itself. */
  element: HTMLElement | null
  /** It showed the focus ring then. */
  ring: boolean
}

/** Call when a menu or panel opens, before it takes the focus. */
export function markFocus(): FocusMark {
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || element === document.body) return { element: null, ring: false }
  return { element, ring: element.matches(':focus-visible') }
}

/** Call when it closes: the focus goes to `to` (by default the marked element), ringed as the mark says. */
export function returnFocus(mark: FocusMark, to: HTMLElement | null = mark.element): void {
  if (!to || !to.isConnected) return
  if (document.activeElement === to) {
    // A key pressed while it had the focus rang it: a new focus takes the mark's ring instead.
    if (mark.ring || !to.matches(':focus-visible')) return
    to.blur()
  }
  // Chromium reads focusVisible (FocusOptions); TypeScript's DOM types do not list it yet.
  to.focus({ preventScroll: true, focusVisible: mark.ring } as FocusOptions)
}
