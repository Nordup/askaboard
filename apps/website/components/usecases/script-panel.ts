/**
 * The app's reading panel (ScriptPanel.tsx in space/), for a use case that plays its scene as the
 * app does: the scene's name, a step bar with one segment per step, the step lines read past a
 * light, and the step count with the playing buttons. Nothing in it works; update(t) sets it from
 * the scene time, so a frame depends only on t.
 */
import { clamp01, ease } from '@/lib/board/kit'
import styles from './script-panel.module.css'

export interface Step {
  /** Scene seconds the step plays. */
  start: number
  end: number
  /** Its line in the reading view. */
  text: string
}

// The app's icons (lucide: Minus, RotateCcw, Pause, SkipForward), at its sizes.
const icon = (size: number, stroke: number, body: string): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const MINUS = icon(14, 1.75, '<path d="M5 12h14"/>')
const REPLAY = icon(14, 1.75, '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>')
const PAUSE = icon(13, 2, '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>')
const NEXT = icon(14, 1.75, '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>')

/** The reading view moves to the next line over this many seconds (the app follows with a 120 ms time constant). */
const MOVE = 0.5

export function scriptPanel(name: string, steps: readonly Step[]) {
  const el = document.createElement('section')
  el.className = styles.panel
  const button = (svg: string, strong = false): string => `<span class="${styles.button}${strong ? ` ${styles.strong}` : ''}">${svg}</span>`
  el.innerHTML =
    `<header class="${styles.header}"><span class="${styles.dot}"></span><span class="${styles.title}"></span>${button(MINUS, true)}</header>` +
    `<div class="${styles.bar}">${steps.map((s) => `<span class="${styles.track}" style="flex-grow:${s.end - s.start}"><span class="${styles.fill}"></span></span>`).join('')}</div>` +
    `<div class="${styles.view}"><div class="${styles.text}">${steps.map(() => `<p class="${styles.para}"></p>`).join('')}</div></div>` +
    `<footer class="${styles.footer}"><span class="${styles.status}"></span>${button(REPLAY)}${button(PAUSE, true)}${button(NEXT)}</footer>`
  el.querySelector(`.${styles.title}`)!.textContent = name
  const fills = Array.from(el.querySelectorAll<HTMLElement>(`.${styles.fill}`))
  const view = el.querySelector<HTMLElement>(`.${styles.view}`)!
  const text = el.querySelector<HTMLElement>(`.${styles.text}`)!
  const paras = Array.from(el.querySelectorAll<HTMLElement>(`.${styles.para}`))
  paras.forEach((p, i) => (p.textContent = steps[i].text))
  const status = el.querySelector<HTMLElement>(`.${styles.status}`)!

  /** The offset that puts line i's middle at the reading point (the middle of the view). */
  const offsetOf = (i: number): number => view.clientHeight / 2 - (paras[i].offsetTop + paras[i].offsetHeight / 2)

  return {
    el,
    /** The panel at scene time t. `phone`: under the picture; `below`: its gap to the board's bottom (px). */
    update(t: number, phone: boolean, below: number): void {
      el.classList.toggle(styles.phone, phone)
      el.style.setProperty('--below', `${below}px`)
      el.style.opacity = String(ease(clamp01(t / 0.4)))
      let i = 0
      steps.forEach((s, k) => t >= s.start && (i = k))
      fills.forEach((f, k) => (f.style.width = `${Math.round(clamp01((t - steps[k].start) / (steps[k].end - steps[k].start)) * 1000) / 10}%`))
      const label = `Step ${i + 1} of ${steps.length}`
      if (status.textContent !== label) status.textContent = label
      const k = ease(clamp01((t - steps[i].start) / MOVE))
      const y = i > 0 ? offsetOf(i - 1) + (offsetOf(i) - offsetOf(i - 1)) * k : offsetOf(0)
      text.style.transform = `translateY(${y}px)`
    }
  }
}
