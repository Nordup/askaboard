import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
 * The one tooltip of the app (design-system.md, "Tooltips"). A control asks for it with `{...tip(label, key)}`:
 * two data attributes, no listeners of its own. <Tooltips /> is mounted once (App.tsx) and owns every listener,
 * so a control that unmounts leaks nothing, and StrictMode's second mount adds and removes the same set.
 * No native `title` in app UI: it shows late, unstyled, and often shows internal data.
 */

/** Hover time before a tooltip shows. */
const DELAY_MS = 500
/** A tooltip that hid less than this long ago lets the next control's tooltip show at once (as macOS does). */
const CHAIN_MS = 300
const TIP_ID = 'app-tooltip'

/** Props that give a control the shared tooltip: a short label, and a shortcut after it (from platform.ts `shortcut()`). */
export function tip(label: string, key?: string): { 'data-tip': string; 'data-tip-key'?: string } {
  return key ? { 'data-tip': label, 'data-tip-key': key } : { 'data-tip': label }
}

interface Shown {
  target: HTMLElement
  label: string
  key: string | null
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null
}

function px(element: HTMLElement, name: string): number {
  return parseFloat(getComputedStyle(element).getPropertyValue(name)) || 0
}

export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let timer: number | undefined
    let watch: number | undefined
    let current: HTMLElement | null = null
    let pending: HTMLElement | null = null
    // The control under a pointer press: no tooltip on it until the pointer leaves it.
    let pressed: HTMLElement | null = null
    let hiddenAt = -Infinity

    const cancel = (): void => {
      window.clearTimeout(timer)
      pending = null
    }
    const hide = (chain = false): void => {
      cancel()
      window.clearInterval(watch)
      if (!current) return
      current.removeAttribute('aria-describedby')
      current = null
      hiddenAt = chain ? performance.now() : -Infinity
      setShown(null)
    }
    const show = (target: HTMLElement): void => {
      cancel()
      window.clearInterval(watch)
      current?.removeAttribute('aria-describedby')
      current = target
      target.setAttribute('aria-describedby', TIP_ID)
      setShown({ target, label: target.dataset.tip ?? '', key: target.dataset.tipKey ?? null })
      // A control can leave the page while its tooltip shows (a panel closes): the tooltip goes with it.
      watch = window.setInterval(() => {
        if (!target.isConnected) hide()
      }, 250)
    }

    const onOver = (event: PointerEvent): void => {
      const target = tipTarget(event.target)
      if (!target || target === current || target === pending || target === pressed) return
      if (performance.now() - hiddenAt < CHAIN_MS) return show(target)
      cancel()
      pending = target
      timer = window.setTimeout(() => show(target), DELAY_MS)
    }
    const onOut = (event: PointerEvent): void => {
      const from = tipTarget(event.target)
      if (!from || tipTarget(event.relatedTarget) === from) return
      if (from === pressed) pressed = null
      if (from === pending) cancel()
      if (from === current) hide(true)
    }
    const onDown = (event: PointerEvent): void => {
      pressed = tipTarget(event.target)
      hide()
    }
    const onFocusIn = (event: FocusEvent): void => {
      const target = tipTarget(event.target)
      if (target && target === event.target && target.matches(':focus-visible')) show(target)
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (event.target === current) hide()
    }
    const onAny = (): void => hide()

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onAny, true)
    document.addEventListener('click', onAny, true)
    document.addEventListener('scroll', onAny, true)
    document.addEventListener('wheel', onAny, { capture: true, passive: true })
    window.addEventListener('blur', onAny)
    return () => {
      hide()
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onAny, true)
      document.removeEventListener('click', onAny, true)
      document.removeEventListener('scroll', onAny, true)
      document.removeEventListener('wheel', onAny, { capture: true })
      window.removeEventListener('blur', onAny)
    }
  }, [])

  // Below the control, above it when there is no room below; always inside the window.
  useLayoutEffect(() => {
    const element = ref.current
    if (!shown || !element) return
    const gap = px(element, '--tooltip-gap')
    const margin = px(element, '--tooltip-margin')
    const anchor = shown.target.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - box.width / 2, margin), window.innerWidth - margin - box.width)
    let top = anchor.bottom + gap
    if (top + box.height > window.innerHeight - margin) top = Math.max(margin, anchor.top - gap - box.height)
    element.style.left = `${Math.round(left)}px`
    element.style.top = `${Math.round(top)}px`
    element.style.visibility = 'visible'
  }, [shown])

  if (!shown) return null
  return createPortal(
    <div ref={ref} id={TIP_ID} role="tooltip" className="tooltip">
      {shown.label}
      {shown.key && <span className="tooltip__key">{shown.key}</span>}
    </div>,
    document.body
  )
}
