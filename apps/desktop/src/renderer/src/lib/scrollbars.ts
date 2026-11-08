/**
 * The scrollbars' two states (decisions U14, U16; app.css, "Scrollbars"). Imported once by main.tsx; it serves every
 * scroll area of the page.
 *
 * 1. "Shown while it scrolls": every scroll of an element marks it data-scrolling, and the mark goes this long after
 *    its last scroll; the CSS fades the thumb in and out with it. One listener for the whole page.
 * 2. "Overflows": every `.scroll-area` carries data-overflow while its content is taller than the area. The CSS then
 *    takes the scrollbar's width out of the area's right padding, so the content's right edge stays put; without
 *    overflow there is no gutter. Resize observer callbacks run before paint, so the change never shows a moved frame.
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

const SCROLL_AREA = 'scroll-area'

/** The scroll areas now watched, each with the observer of its own children. */
const areas = new Map<HTMLElement, MutationObserver>()

function measure(area: HTMLElement): void {
  area.toggleAttribute('data-overflow', area.scrollHeight > area.clientHeight)
}

// The area's own size and its children's sizes: together they set its scroll height.
const sizes = new ResizeObserver((entries) => {
  const seen = new Set<HTMLElement>()
  for (const entry of entries) {
    const target = entry.target as HTMLElement
    const area = target.classList.contains(SCROLL_AREA) && areas.has(target) ? target : target.parentElement
    if (area && areas.has(area) && !seen.has(area)) {
      seen.add(area)
      measure(area)
    }
  }
})

function watch(area: HTMLElement): void {
  if (areas.has(area)) return
  // A child that comes or goes changes the scroll height: observe the new children and measure again.
  const children = new MutationObserver(() => {
    for (const child of area.children) sizes.observe(child)
    measure(area)
  })
  children.observe(area, { childList: true })
  areas.set(area, children)
  sizes.observe(area)
  for (const child of area.children) sizes.observe(child)
}

function unwatch(area: HTMLElement): void {
  areas.get(area)?.disconnect()
  areas.delete(area)
  sizes.unobserve(area)
  for (const child of area.children) sizes.unobserve(child)
}

function watchWithin(node: Node): void {
  if (!(node instanceof HTMLElement)) return
  if (node.classList.contains(SCROLL_AREA)) watch(node)
  if (node.firstElementChild) for (const area of node.getElementsByClassName(SCROLL_AREA)) watch(area as HTMLElement)
}

// Scroll areas come and go with the UI (a menu opens, a panel closes); the board's own nodes never hold one.
const pageObserver = new MutationObserver((records) => {
  let removed = false
  for (const record of records) {
    if (record.target instanceof Element && record.target.closest('.board')) continue
    for (const node of record.addedNodes) watchWithin(node)
    if (record.removedNodes.length > 0) removed = true
  }
  if (removed) for (const area of [...areas.keys()]) if (!area.isConnected) unwatch(area)
})

function start(): void {
  pageObserver.observe(document.body, { childList: true, subtree: true })
  watchWithin(document.body)
}

if (document.body) start()
else document.addEventListener('DOMContentLoaded', start, { once: true })
