/**
 * The scrollbars' "shown while it scrolls" (decision U14; app.css, "Scrollbars"): every scroll of an element marks it
 * data-scrolling, and the mark goes this long after its last scroll; the CSS fades the thumb in and out with it.
 * Imported once by main.tsx; one listener for the whole page.
 */
const SHOWN_AFTER_SCROLL_MS = 800

const timers = new WeakMap<Element, number>()

window.addEventListener(
  'scroll',
  (event) => {
    const element = event.target
    if (!(element instanceof Element)) return
    const timer = timers.get(element)
    if (timer === undefined) element.setAttribute('data-scrolling', '')
    else clearTimeout(timer)
    timers.set(
      element,
      window.setTimeout(() => {
        timers.delete(element)
        element.removeAttribute('data-scrolling')
      }, SHOWN_AFTER_SCROLL_MS)
    )
  },
  { capture: true, passive: true }
)
