/**
 * The app's reading panel (ScriptPanel.tsx in space/), for a use case that plays its scene as the
 * app does: the scene's name, a step bar with one segment per step, the step lines read past a
 * light, and the step count with the playing buttons. Nothing in it works but the sound button (an
 * agent's voiced scene, agent-scene.ts); update(t) sets it from the scene time, so a frame depends only on t.
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
// lucide Volume2 and VolumeX: the voice on and off.
const SPEAKER = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>'
const SOUND_ON = icon(14, 1.75, `${SPEAKER}<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>`)
const SOUND_OFF = icon(14, 1.75, `${SPEAKER}<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>`)

/** A voiced scene's extras: the status from the scene's own steps (its lines are the panel's steps), and the voice's button. */
export interface PanelVoice {
  status(t: number): string
  on(): boolean
  toggle(): void
}

/** The reading view moves to the next line over this many seconds (the app follows with a 120 ms time constant). */
const MOVE = 0.5

export function scriptPanel(name: string, steps: readonly Step[], voice?: PanelVoice) {
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
  // The voice's button, before the minus: the one control here that works (the board's material takes no pointer otherwise).
  let sound: HTMLButtonElement | null = null
  if (voice) {
    sound = document.createElement('button')
    sound.type = 'button'
    sound.className = `${styles.button} ${styles.strong} ${styles.sound}`
    sound.addEventListener('click', () => voice.toggle())
    el.querySelector('header')!.insertBefore(sound, el.querySelector('header')!.lastElementChild)
  }
  let soundShown: boolean | null = null

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
      const label = voice ? voice.status(t) : `Step ${i + 1} of ${steps.length}`
      if (sound && soundShown !== voice!.on()) {
        soundShown = voice!.on()
        sound.innerHTML = soundShown ? SOUND_ON : SOUND_OFF
        sound.setAttribute('aria-label', soundShown ? 'Turn the voice off' : 'Turn the voice on')
        sound.classList.toggle(styles.soundOn, soundShown)
      }
      if (status.textContent !== label) status.textContent = label
      const k = ease(clamp01((t - steps[i].start) / MOVE))
      const y = i > 0 ? offsetOf(i - 1) + (offsetOf(i) - offsetOf(i - 1)) * k : offsetOf(0)
      text.style.transform = `translateY(${y}px)`
    }
  }
}
