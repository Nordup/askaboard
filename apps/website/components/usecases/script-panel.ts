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
  /** Its lines in the reading view (one line: `text`). */
  text?: string
  lines?: readonly string[]
}

// The app's icons (lucide: Minus, RotateCcw, Pause, SkipForward), at its sizes.
const icon = (size: number, stroke: number, body: string): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const MINUS = icon(14, 1.75, '<path d="M5 12h14"/>')
const REPLAY = icon(14, 1.75, '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>')
const PAUSE = icon(13, 2, '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>')
const NEXT = icon(14, 1.75, '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>')
/**
 * The app's reading point (ScriptPanel.tsx readingPoint), px from the text's top: P_k is the middle of the first
 * line of step k; during step k it moves at an even pace from P_k to P_k+1, so it arrives as step k+1 starts; the
 * last step moves on to the middle of the last line. The view scrolls to keep it in the middle (clamped at the
 * text's top and bottom) and the mask lights it. The app eases toward that target over 120 ms; the target itself
 * moves smoothly, so here it is used as it is (a frame depends only on t).
 */
function readingPoint(firsts: number[], last: number, steps: readonly Step[], t: number): number {
  let point = firsts[0]
  for (let i = 0; i < steps.length && steps[i].start <= t; i++) {
    const to = i + 1 < steps.length ? firsts[i + 1] : last
    const dur = steps[i].end - steps[i].start
    point = firsts[i] + (to - firsts[i]) * (dur > 0 ? clamp01((t - steps[i].start) / dur) : 1)
  }
  return point
}

export function scriptPanel(name: string, steps: readonly Step[]) {
  const lines = steps.map((s) => s.lines ?? [s.text ?? ''])
  const el = document.createElement('section')
  el.className = styles.panel
  const button = (svg: string, strong = false): string => `<span class="${styles.button}${strong ? ` ${styles.strong}` : ''}">${svg}</span>`
  el.innerHTML =
    `<header class="${styles.header}"><span class="${styles.dot}"></span><span class="${styles.title}"></span>${button(MINUS, true)}</header>` +
    `<div class="${styles.bar}">${steps.map((s) => `<span class="${styles.track}" style="flex-grow:${s.end - s.start}"><span class="${styles.fill}"></span></span>`).join('')}</div>` +
    `<div class="${styles.view}"><div class="${styles.text}">${lines.flat().map(() => `<p class="${styles.para}"></p>`).join('')}</div></div>` +
    `<footer class="${styles.footer}"><span class="${styles.status}"></span>${button(REPLAY)}${button(PAUSE, true)}${button(NEXT)}</footer>`
  el.querySelector(`.${styles.title}`)!.textContent = name
  const fills = Array.from(el.querySelectorAll<HTMLElement>(`.${styles.fill}`))
  const view = el.querySelector<HTMLElement>(`.${styles.view}`)!
  const text = el.querySelector<HTMLElement>(`.${styles.text}`)!
  const paras = Array.from(el.querySelectorAll<HTMLElement>(`.${styles.para}`))
  lines.flat().forEach((line, i) => (paras[i].textContent = line))
  // Each step's first paragraph.
  const firstPara = lines.map((_, k) => lines.slice(0, k).reduce((n, l) => n + l.length, 0))
  const status = el.querySelector<HTMLElement>(`.${styles.status}`)!

  // A frame writes only what changed, and reads the layout only when it can have changed: a forced layout in each
  // frame was most of the panel's cost.
  const shown = new Map<string, string>()
  const put = (key: string, value: string, write: (value: string) => void): void => {
    if (shown.get(key) === value) return
    shown.set(key, value)
    write(value)
  }
  /** The reading view's layout (px): measured again when the panel resizes or goes into a page, or turns phone or back. */
  let laid: { firsts: number[]; last: number; viewH: number; textH: number } | null = null
  let laidPhone = false
  if (typeof ResizeObserver !== 'undefined') {
    const resized = new ResizeObserver(() => (laid = null))
    resized.observe(view)
    resized.observe(text)
  }
  const measure = (): NonNullable<typeof laid> => {
    const line = parseFloat(getComputedStyle(paras[0]).lineHeight) || 24
    const firsts = firstPara.map((p) => paras[p].offsetTop + line / 2)
    const lastPara = paras[paras.length - 1]
    const last = Math.max(firsts[0], lastPara.offsetTop + lastPara.offsetHeight - line / 2)
    return { firsts, last, viewH: view.clientHeight, textH: text.offsetHeight }
  }

  return {
    el,
    /** The panel at scene time t. `phone`: under the picture; `below`: its gap to the board's bottom (px). */
    update(t: number, phone: boolean, below: number): void {
      if (phone !== laidPhone) {
        laidPhone = phone
        laid = null
      }
      put('phone', String(phone), () => el.classList.toggle(styles.phone, phone))
      put('below', `${below}px`, (v) => el.style.setProperty('--below', v))
      put('opacity', String(ease(clamp01(t / 0.4))), (v) => (el.style.opacity = v))
      let i = 0
      steps.forEach((s, k) => t >= s.start && (i = k))
      // A transform, not a width: the bar's fills move in each frame, and a width is a layout.
      fills.forEach((f, k) => put(`fill${k}`, `scaleX(${Math.round(clamp01((t - steps[k].start) / (steps[k].end - steps[k].start)) * 1000) / 1000})`, (v) => (f.style.transform = v)))
      const label = `Step ${i + 1} of ${steps.length}`
      if (status.textContent !== label) status.textContent = label
      // The reading view. Out of a page (the shell's offscreen draw) there is no layout to read.
      if (!el.isConnected) return
      laid ??= measure()
      const point = readingPoint(laid.firsts, laid.last, steps, t)
      const scroll = Math.max(0, Math.min(point - laid.viewH / 2, laid.textH - laid.viewH))
      put('scroll', `translateY(${-scroll}px)`, (v) => (text.style.transform = v))
      put('at', `${point - scroll}px`, (v) => view.style.setProperty('--reading-at', v))
    }
  }
}
