/**
 * An agent's own scene, played on the shell's board as the app plays it. The founder (2026-11-07): the use case is
 * what an agent drew in the lab for the request, its program file untouched, with its voice and its lines at the same
 * times. space/scripts/lab/export-scene.mjs runs that file through the app's own scene library (live-prelude.js) and
 * writes the scene description: each object (an SVG path with its style), its timeline (draw, fill, opacity, scale
 * tracks), the voiced lines and the steps. This file plays the description:
 * - the timeline's values as space/src/renderer/src/live/timeline.ts gives them (base, value, matrix);
 * - each shape as the app's SVG node (live/compile.ts): stroke in its colour, round caps and joins, its fill;
 * - a stroke drawn on by its dash (board/playback.ts revealDash), the fill at its share, the opacity;
 * - the agent's view (the board area it drew for) fitted to the shell's board;
 * - the voice as live/voice.ts follows it: one audio element set from the scene time, line by line.
 * Only what the shapes and tracks need is here: a scene with ink, text, HTML or worlds needs more of the app.
 */
import { hex } from '@/lib/board/colors'
import { PILL_ROOM } from './placeholder'
import { scriptPanel } from './script-panel'
import styles from './agent-scene.module.css'
import type { Animation } from './index'

type Prop = 'draw' | 'fill' | 'opacity' | 'scale' | 'x' | 'y' | 'rotate'
type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'smooth'
type Matrix = [number, number, number, number, number, number]

interface Track {
  obj: number
  prop: Prop
  start: number
  dur: number
  from?: number
  to: number
  ease: Ease
  until?: number
}

interface SceneObject {
  id: number
  kind: string
  vis: 'hidden' | 'shown'
  pivot: [number, number]
  parent?: number
  d?: string
  style?: { color: string; width: number; opacity: number; fill?: string; fillOpacity?: number }
}

export interface AgentScene {
  name: string
  view: { x: number; y: number; width: number; height: number }
  duration: number
  objects: SceneObject[]
  actions: Track[]
  steps: { name: string; at: number }[]
  cues: { text: string; at: number; dur: number; voice?: { clip: string; from: number } }[]
}

// shared/live-scene.ts SCENE_EASES and trackNumber.
const EASES: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  smooth: (t) => t * t * (3 - 2 * t)
}
const trackNumber = (a: Track, from: number, to: number, t: number): number => {
  const tt = a.until !== undefined ? Math.min(t, a.until) : t
  return tt >= a.start + a.dur ? to : from + (to - from) * EASES[a.ease]((tt - a.start) / a.dur)
}
const complete = (a: Track, t: number): boolean => (a.until !== undefined ? Math.min(t, a.until) : t) >= a.start + a.dur
const multiply = (p: Matrix, q: Matrix): Matrix => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5]
]

/** The timeline's values (live/timeline.ts): each action starts from the value of the ones before it. */
function timeline(scene: AgentScene) {
  const lanes = scene.objects.map(() => ({}) as Partial<Record<Prop, Track[]>>)
  for (const a of scene.actions) (lanes[a.obj][a.prop] ??= []).push(a)
  const base = (o: SceneObject, prop: Prop): number => (prop === 'draw' || prop === 'fill' ? (o.vis === 'hidden' ? 0 : 1) : prop === 'scale' || prop === 'opacity' ? 1 : 0)
  const value = (id: number, prop: Prop, t: number): number => {
    const list = lanes[id][prop]
    if (!list) return base(scene.objects[id], prop)
    let k = -1
    for (let i = 0; i < list.length && list[i].start <= t; i++) k = i
    let r = k
    while (r >= 0 && list[r].from === undefined && !complete(list[r], t)) r--
    let v = r < 0 ? base(scene.objects[id], prop) : 0
    for (let j = Math.max(0, r); j <= k; j++) v = trackNumber(list[j], list[j].from ?? v, list[j].to, t)
    return v
  }
  const matrix = (id: number, t: number): Matrix => {
    const o = scene.objects[id]
    const s = value(id, 'scale', t)
    const rot = (value(id, 'rotate', t) * Math.PI) / 180
    const [px, py] = o.pivot
    const a = Math.cos(rot) * s
    const b = Math.sin(rot) * s
    const own: Matrix = [a, b, -b, a, px + value(id, 'x', t) - (a * px - b * py), py + value(id, 'y', t) - (b * px + a * py)]
    return o.parent === undefined ? own : multiply(matrix(o.parent, t), own)
  }
  return { value, matrix }
}

const SVG = 'http://www.w3.org/2000/svg'
// lucide Volume2.
const VOLUME =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>'

export function agentScene(scene: AgentScene, voiceUrl: string): Animation {
  const tl = timeline(scene)
  const shapes = scene.objects.filter((o) => o.kind === 'shape' && o.d && o.style)
  // The panel's steps as the app's (ScriptPanel.tsx panelSteps): a first step before the first named one, then one
  // per step(), each to the next one's start (the last to the end), with the lines said in it.
  const starts = [...(scene.steps[0]?.at > 0 || !scene.steps.length ? [0] : []), ...scene.steps.map((s) => s.at)]
  const steps = starts.map((start, i) => {
    const end = starts[i + 1] ?? scene.duration
    return { start, end, lines: scene.cues.filter((c) => c.at >= start && (c.at < end || i === starts.length - 1)).map((c) => c.text) }
  })

  // The voice: off until the visitor turns it on (a browser plays sound only after a click). The big button over the
  // shell invites them until they press it or hide it. While the voice is on, a small button fixed at the page's
  // bottom right turns it off; then that button goes and the big one comes back (founder, 2026-11-07).
  let soundOn = false
  let dismissed = false
  let audio: HTMLAudioElement | null = null
  let lastT = -1
  let quiet: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    audio?.pause()
  }
  let invite: HTMLElement | null = null
  let off: HTMLButtonElement | null = null
  const refresh = (): void => {
    invite?.classList.toggle(styles.gone, soundOn || dismissed)
    off?.classList.toggle(styles.gone, !soundOn)
  }
  const setSound = (on: boolean): void => {
    soundOn = on
    if (on && audio) {
      // Started inside the click, so the browser allows it; the next frame sets its time or pauses it.
      void audio.play().catch(() => undefined)
    } else stop()
    refresh()
  }
  /** live/voice.ts followVoice: the line at t plays from its place in the clip; between lines, quiet. */
  const follow = (t: number): void => {
    if (!audio) return
    const advancing = t > lastT && t < scene.duration
    lastT = t
    const line = scene.cues.find((c) => c.voice && t >= c.at && t < c.at + c.dur)
    if (!soundOn || !advancing || !line?.voice) {
      if (!audio.paused) audio.pause()
      return
    }
    const target = line.voice.from + (t - line.at)
    if (audio.paused) {
      audio.currentTime = target
      void audio.play().catch(() => undefined)
    } else if (Math.abs(audio.currentTime - target) > 0.2) audio.currentTime = target
    // The shell stops calling draw when the scene is off screen or faded out: the voice stops with it (a hidden tab at once).
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(stop, 1000)
  }

  const panel =
    typeof document === 'undefined'
      ? null
      : scriptPanel(scene.name.charAt(0).toUpperCase() + scene.name.slice(1), steps)
  let host: HTMLElement | null = null
  let svg: SVGSVGElement | null = null
  let root: SVGGElement | null = null
  const paths = new Map<number, { el: SVGPathElement; length: number | null }>()

  const build = (): void => {
    svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none')
    root = document.createElementNS(SVG, 'g')
    svg.appendChild(root)
    for (const o of shapes) {
      const style = o.style!
      const el = document.createElementNS(SVG, 'path')
      el.setAttribute('d', o.d!)
      el.setAttribute('fill', style.fill ? hex(style.fill) : 'none')
      el.setAttribute('stroke', hex(style.color))
      el.setAttribute('stroke-width', String(style.width))
      el.setAttribute('stroke-linecap', 'round')
      el.setAttribute('stroke-linejoin', 'round')
      root.appendChild(el)
      paths.set(o.id, { el, length: null })
    }
    audio = new Audio(voiceUrl)
    audio.preload = 'auto'
    invite = document.createElement('div')
    invite.className = styles.invite
    invite.innerHTML =
      `<button type="button" class="${styles.speaker}" aria-label="Turn on the voice"><span class="${styles.ring}"></span><span class="${styles.ring}"></span>${VOLUME}</button>` +
      `<span class="${styles.label}">Press to hear Claude explain it</span><button type="button" class="${styles.hide}">Hide</button>`
    invite.querySelector(`.${styles.speaker}`)!.addEventListener('click', () => setSound(true))
    invite.querySelector(`.${styles.hide}`)!.addEventListener('click', () => {
      dismissed = true
      refresh()
    })
    // On the page itself (fixed to the viewport), not in the shell: the shell's window is scaled and moves.
    off = document.createElement('button')
    off.type = 'button'
    off.className = `${styles.off} ${styles.gone}`
    off.setAttribute('aria-label', 'Turn the voice off')
    off.innerHTML = VOLUME
    off.addEventListener('click', () => setSound(false))
    document.body.appendChild(off)
    refresh()
    document.addEventListener('visibilitychange', () => document.hidden && stop())
  }

  const draw = (_c: CanvasRenderingContext2D, w: number, h: number, t: number): void => {
    if (!host || !root) return
    // The window's scale and the room the panel leaves, as the other use cases (gps.ts).
    const lw = host.clientWidth || w
    const lh = host.clientHeight || h
    const s = w / lw
    const phone = lw < 760
    const below = PILL_ROOM / s + 14
    panel?.update(t, phone, below)
    const panelH = panel?.el.offsetHeight ?? 0
    // The agent's view is the board it drew for: on a phone, the board above the panel.
    const rh = phone ? lh - (panelH + below + 12) : lh
    const v = scene.view
    const k = Math.min(lw / v.width, rh / v.height)
    const ox = (lw - v.width * k) / 2 - v.x * k
    const oy = (rh - v.height * k) / 2 - v.y * k
    root.setAttribute('transform', `matrix(${k} 0 0 ${k} ${ox} ${oy})`)
    // The invite in the middle of the whole app window (founder: the shell's centre, not the board's), in the host's
    // own px.
    const shell = host.closest('[data-shell-frame]')?.firstElementChild
    if (shell) {
      const hr = host.getBoundingClientRect()
      const wr = shell.getBoundingClientRect()
      const zoom = hr.width / lw || 1
      invite!.style.left = `${(wr.left + wr.width / 2 - hr.left) / zoom}px`
      invite!.style.top = `${(wr.top + wr.height / 2 - hr.top) / zoom}px`
    }

    for (const o of shapes) {
      const p = paths.get(o.id)!
      const style = o.style!
      const drawn = tl.value(o.id, 'draw', t)
      const fill = tl.value(o.id, 'fill', t)
      const opacity = Math.max(0, Math.min(1, tl.value(o.id, 'opacity', t))) * style.opacity
      if ((drawn <= 0 && fill <= 0) || opacity <= 0.001) {
        p.el.style.display = 'none'
        continue
      }
      p.el.style.display = ''
      p.el.style.opacity = opacity < 1 ? String(opacity) : ''
      const m = tl.matrix(o.id, t)
      const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
      if (identity) p.el.removeAttribute('transform')
      else p.el.setAttribute('transform', `matrix(${m.join(' ')})`)
      if (drawn < 1) {
        p.length ??= p.el.getTotalLength()
        p.el.style.strokeDasharray = `${p.length} ${p.length}`
        p.el.style.strokeDashoffset = String(p.length * (1 - Math.max(0, drawn)))
      } else {
        p.el.style.strokeDasharray = ''
        p.el.style.strokeDashoffset = ''
      }
      const baseFill = style.fillOpacity ?? 1
      p.el.style.fillOpacity = String(fill >= 1 ? baseFill : baseFill * Math.max(0, fill))
    }
    follow(t)
  }

  return {
    duration: scene.duration,
    draw,
    mount(el) {
      host = el
      if (!svg) build()
      el.appendChild(svg!)
      if (panel) el.appendChild(panel.el)
      el.append(invite!)
      lastT = -1
    },
    unmount() {
      stop()
      svg?.remove()
      panel?.el.remove()
      invite?.remove()
      setSound(false)
      host = null
    }
  }
}
