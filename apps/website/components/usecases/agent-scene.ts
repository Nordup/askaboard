/**
 * An agent's own scene, played on the shell's board as the app plays it. The founder (2026-11-07): the use case is
 * what an agent drew in the lab for the request, its program file untouched, with its voice and its lines at the same
 * times. apps/desktop/scripts/lab/export-scene.mjs runs that file through the app's own scene library (live-prelude.js) and
 * writes the scene description: each object (an SVG path with its style), its timeline (draw, fill, opacity, scale
 * tracks), the voiced lines and the steps. This file plays the description:
 * - the timeline's values as apps/desktop/src/renderer/src/live/timeline.ts gives them (base, value, matrix);
 * - each shape as the app's SVG node (live/compile.ts): stroke in its colour, round caps and joins, its fill, its dash
 *   pattern and hatching;
 * - a stroke drawn on by its dash (board/playback.ts revealDash), the fill at its share, the opacity;
 * - a changing shape (a recipe, as a bar that grows) by the sweep's samples, blended as live/player.ts does, until its
 *   last change;
 * - ink (write, label, around) as the app's ink canvas above the shapes: the strokes the export made with the app's
 *   hand (board/hand.ts humanize), drawn with the site's copy of board/paint.ts, stroke by stroke as the app reveals them;
 * - an object that shows when it is made (no draw action) from its time of making on;
 * - the agent's view (the board area it drew for) fitted to the shell's board;
 * - the voice line by line from one audio element, as live/voice.ts follows it, except that here the voice leads: the
 *   scene waits for its words (lag).
 * Only what shapes, ink and tracks need is here: a scene with text, HTML or worlds needs more of the app.
 */
import { hex } from '@/lib/board/colors'
import { drawStroke, ranges, revealPoints } from '@/lib/board/paint'
import type { InkPoint } from '@/lib/board/hand'
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
  created: number
  d?: string
  style?: { color: string; width: number; opacity: number; fill?: string; fillOpacity?: number; dash?: number[]; hatch?: string }
  /** A changing shape: the sweep's samples, shown until lastChange (then d). */
  samples?: { t: number; d: string; width?: number }[]
  lastChange?: number
  /** Ink: its strokes in its own points, as the app draws them. */
  ink?: { width: number; tool: 'pen' | 'highlighter'; strokes: InkPoint[][] }
}

export interface AgentScene {
  name: string
  view: { x: number; y: number; width: number; height: number }
  duration: number
  objects: SceneObject[]
  actions: Track[]
  steps: { name: string; at: number }[]
  cues: { text: string; at: number; dur: number; voice?: { clip: string; from: number } }[]
  /** The scene's camera moves (camera()): each glides the view to its fit, a board rect [x, y, w, h] with its pad. */
  camera?: { start: number; dur: number; fit?: [number, number, number, number]; center?: [number, number]; ease: Ease }[]
  /** The learner's own ink on the board before the scene (a lab run's --learner-board), in board points. */
  learner?: { color: string; width: number; tool: 'pen' | 'highlighter'; points: InkPoint[] }[]
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

/** live/player.ts BLEND_GAP: samples further apart than this are not blended. */
const BLEND_GAP = 0.05
const r2 = (v: number): number => Math.round(v * 100) / 100
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi
/** A changing shape's d at t (live/player.ts locate and blendD): the sample at t, blended with the next one. */
function sampleD(samples: NonNullable<SceneObject['samples']>, t: number): string {
  if (t <= samples[0].t) return samples[0].d
  let lo = 0
  let hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  const a = samples[lo]
  const b = samples[Math.min(lo + 1, samples.length - 1)]
  if (b === a || b.t - a.t > BLEND_GAP) return a.d
  const k = (t - a.t) / (b.t - a.t)
  const an = a.d.match(NUMBER) ?? []
  const bn = b.d.match(NUMBER) ?? []
  const parts = a.d.split(NUMBER)
  if (an.length !== bn.length || b.d.split(NUMBER).join('#') !== parts.join('#')) return a.d
  let out = parts[0]
  for (let i = 0; i < an.length; i++) out += String(r2(Number(an[i]) + (Number(bn[i]) - Number(an[i])) * k)) + parts[i + 1]
  return out
}

/** board/playback.ts revealDash: a dash list that shows the first `shown` length of a path drawn with `pattern` (or solid). */
function revealDash(length: number, shown: number, pattern: number[] | null): { dash: string; offset: string } {
  if (!pattern) return { dash: `${length} ${length}`, offset: `${length - shown}` }
  const out: number[] = []
  let at = 0
  let k = 0
  while (at < shown && out.length < 2000) {
    const piece = pattern[k % pattern.length]
    const on = k % 2 === 0
    const use = Math.min(piece, shown - at)
    out.push(on ? use : piece)
    at += on ? use : piece
    k++
  }
  if (out.length % 2 === 1) out.push(length + 1)
  else out[out.length - 1] += length + 1
  return { dash: out.map((v) => Math.round(v * 100) / 100).join(' '), offset: '0' }
}

const lineLength = (line: readonly InkPoint[]): number => {
  let length = 0
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  return length
}

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

/** The voice's clock (lag below), in seconds: a gap in the clip under SEEK plays on with no seek; the board may run
 * SLACK ahead of the words (the audio clock's steps); audio more than DRIFT ahead goes back to the board's place. */
const SEEK = 0.05
const SLACK = 0.05
const DRIFT = 0.25
/** How long a line waits for its audio to move (ms) before it goes on without sound. */
const HOLD_LIMIT = 1000

/** One scene's part in the page's voice: its invite, its audio. */
interface VoiceMember {
  refresh: () => void
  stop: () => void
  unlock: () => void
}
// The voice is one choice for the page (founder, 2026-11-07): turned on in one scene, it is on in every scene until
// the page reloads or the visitor turns it off with the one small button fixed at the page's bottom right.
const voice = { on: false, dismissed: false, members: new Set<VoiceMember>() }
let voiceOff: HTMLButtonElement | null = null
const refreshVoice = (): void => {
  if (!voiceOff) {
    // On the page itself (fixed to the viewport), not in a shell: the shell's window is scaled and moves.
    voiceOff = document.createElement('button')
    voiceOff.type = 'button'
    voiceOff.className = styles.off
    voiceOff.setAttribute('aria-label', 'Turn the voice off')
    voiceOff.innerHTML = VOLUME
    voiceOff.addEventListener('click', () => setVoice(false))
    document.body.appendChild(voiceOff)
  }
  voiceOff.classList.toggle(styles.gone, !voice.on)
  for (const m of voice.members) m.refresh()
}
const setVoice = (on: boolean): void => {
  voice.on = on
  // Inside the click, every scene's audio gets the browser's leave to play; the next frame of each sets its time.
  for (const m of voice.members) on ? m.unlock() : m.stop()
  refreshVoice()
}

export function agentScene(scene: AgentScene, voiceUrl: string): Animation {
  const tl = timeline(scene)
  const shapes = scene.objects.filter((o) => o.kind === 'shape' && o.d && o.style)
  // Ink, with each stroke's share of the object's drawing (live/compile.ts ranges).
  const inks = scene.objects
    .filter((o) => o.kind === 'ink' && o.ink && o.style)
    .map((o) => ({ o, ink: o.ink!, ranges: ranges(o.ink!.strokes.map(lineLength)), color: hex(o.style!.color) }))
  /** The board rect in view at t: the agent's view, then each camera move's fit, glided over the move. */
  const viewAt = (t: number): { x: number; y: number; width: number; height: number } => {
    let v = scene.view
    for (const c of scene.camera ?? []) {
      if (t <= c.start) break
      const to = c.fit
        ? { x: c.fit[0], y: c.fit[1], width: c.fit[2], height: c.fit[3] }
        : c.center
          ? { ...v, x: c.center[0] - v.width / 2, y: c.center[1] - v.height / 2 }
          : v
      const k = c.dur > 0 ? EASES[c.ease](Math.min(1, (t - c.start) / c.dur)) : 1
      v = { x: v.x + (to.x - v.x) * k, y: v.y + (to.y - v.y) * k, width: v.width + (to.width - v.width) * k, height: v.height + (to.height - v.height) * k }
    }
    return v
  }
  /** An object that shows when it is made is not there before (live/player.ts objectLook `before`). */
  const before = (o: SceneObject, t: number): boolean => o.vis === 'shown' && t < o.created
  // The panel's steps as the app's (ScriptPanel.tsx panelSteps): a first step before the first named one, then one
  // per step(), each to the next one's start (the last to the end), with the lines said in it.
  const starts = [...(scene.steps[0]?.at > 0 || !scene.steps.length ? [0] : []), ...scene.steps.map((s) => s.at)]
  const steps = starts.map((start, i) => {
    const end = starts[i + 1] ?? scene.duration
    return { start, end, lines: scene.cues.filter((c) => c.at >= start && (c.at < end || i === starts.length - 1)).map((c) => c.text) }
  })

  // The voice: off until the visitor turns it on (a browser plays sound only after a click). The big button over the
  // shell invites them until they press it or hide it. The choice is the page's (`voice` below): on in one scene, on
  // in all of them until the page reloads or the small button at the page's bottom right turns it off.
  // The audio is made with the scene, not at its first mount, so the visitor's click primes every scene's (unlock).
  let audio: HTMLAudioElement | null = null
  if (typeof window !== 'undefined') {
    const a = new Audio()
    a.preload = 'auto'
    // The whole file now, as the section comes near (the shell loads this module then): each line's seek is local.
    fetch(voiceUrl)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => (a.src = URL.createObjectURL(blob)))
      .catch(() => (a.src = voiceUrl))
    audio = a
  }
  let lastT = -1
  let quiet: ReturnType<typeof setTimeout> | null = null
  let priming = false
  /** The line the audio plays now, the lines this play goes on without (their audio failed), and when the audio last moved. */
  let owner: AgentScene['cues'][number] | null = null
  const skipped = new Set<AgentScene['cues'][number]>()
  let moved = { at: -1, since: 0 }
  const stop = (): void => {
    audio?.pause()
  }
  let invite: HTMLElement | null = null
  const member: VoiceMember = {
    refresh: () => invite?.classList.toggle(styles.gone, voice.on || voice.dismissed),
    stop,
    unlock: () => {
      // Inside the click, so the browser lets this scene's audio play later too; muted, so the visitor hears nothing.
      // A line that starts meanwhile (lag) takes the audio over: it unmutes it and keeps it playing.
      if (!audio || !audio.paused) return
      const a = audio
      priming = true
      a.muted = true
      void a
        .play()
        .then(() => priming && a.pause())
        .catch(() => undefined)
        .finally(() => {
          if (priming) a.muted = false
          priming = false
        })
    },
  }
  /**
   * The voice leads (live/voice.ts followVoice, with the clock turned round): during a voiced line the scene is where
   * the audio is, so a play() that takes 100-300 ms to sound holds the board at the line's start instead of drawing
   * ahead of the words. Returns how far the scene at t is ahead of its voice; the shell moves the scene time back by
   * that (Animation.lag). Between lines the audio pauses at the line's end; the clip is the lines back to back, so the
   * next line mostly goes on from there with no seek. Audio that does not move for HOLD_LIMIT lets the line go on
   * without sound, so a failed voice never stops the board.
   */
  const lag = (t: number): number => {
    if (!audio) return 0
    // Back to an earlier time: the scene plays again, every line gets its voice again.
    if (t < lastT) {
      owner = null
      skipped.clear()
    }
    const ahead = voiceAhead(t, audio)
    // The time the shell draws: a held frame is not a step back.
    lastT = t - ahead
    return ahead
  }
  const voiceAhead = (t: number, a: HTMLAudioElement): number => {
    // The shell stops calling when the scene is off screen or faded out: the voice stops with it (a hidden tab at once).
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(stop, 1000)
    const line = voice.on ? scene.cues.find((c) => c.voice && t >= c.at && t < c.at + c.dur) : undefined
    if (!line?.voice || skipped.has(line)) {
      owner = null
      if (!a.paused) a.pause()
      return 0
    }
    const from = line.voice.from
    const now = performance.now()
    const skip = (): number => {
      skipped.add(line)
      owner = null
      a.pause()
      return 0
    }
    if (owner !== line) {
      owner = line
      const target = from + (t - line.at)
      if (Math.abs(a.currentTime - target) > SEEK) a.currentTime = target
      moved = { at: a.currentTime, since: now }
    }
    if (a.ended) return skip()
    priming = false
    a.muted = false
    if (a.paused) {
      moved = { at: a.currentTime, since: now }
      // A play our own pause cut short (AbortError) is no failure; one the browser refuses is.
      void a.play().catch((e: unknown) => owner === line && (e as Error)?.name !== 'AbortError' && skip())
    }
    const at = a.currentTime
    if (at !== moved.at) moved = { at, since: now }
    else if (now - moved.since > HOLD_LIMIT) return skip()
    const ahead = t - (line.at + (at - from))
    // The audio ahead of the board (rare: the clip was not where the line is): the audio goes to the board's place.
    if (ahead < -DRIFT) {
      a.currentTime = from + (t - line.at)
      moved = { at: a.currentTime, since: now }
      return 0
    }
    return ahead > SLACK ? ahead : 0
  }

  const panel =
    typeof document === 'undefined'
      ? null
      : scriptPanel(scene.name.charAt(0).toUpperCase() + scene.name.slice(1), steps)
  let host: HTMLElement | null = null
  let svg: SVGSVGElement | null = null
  let root: SVGGElement | null = null
  /** Each shape's node, and `look`: what its last frame wrote to it (a frame writes a node only when its look changes). */
  const paths = new Map<number, { el: SVGPathElement; length: number | null; d: string; pattern: number[] | null; look: string | null }>()
  let canvas: HTMLCanvasElement | null = null
  /**
   * The host's layout, read only when it can have changed: the host or the panel resizes, the shell's scale changes
   * (w, h) or the scene mounts. Reading it in each frame, after the panel's writes, was a forced layout in each frame.
   */
  let laid: { w: number; h: number; lw: number; lh: number; panelH: number; zoom: number } | null = null
  let rootShown = ''
  const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => (laid = null))
  if (panel) resized?.observe(panel.el)

  if (typeof document !== 'undefined') {
    voice.members.add(member)
    document.addEventListener('visibilitychange', () => document.hidden && stop())
  }

  /**
   * Everything that needs no host: the SVG tree, its paths and patterns, the ink canvas, the invite. The shell's
   * offscreen draw does it in idle time before the scene's first turn (draw() with no host), so mount only appends.
   */
  const prepare = (): void => {
    svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none')
    root = document.createElementNS(SVG, 'g')
    svg.appendChild(root)
    const defs = document.createElementNS(SVG, 'defs')
    for (const o of shapes) {
      const style = o.style!
      const el = document.createElementNS(SVG, 'path')
      el.setAttribute('d', o.d!)
      let fill = style.fill ? hex(style.fill) : 'none'
      if (style.hatch) {
        // live/compile.ts: diagonal lines in the hatch colour, in the shape's own points.
        const gap = Math.max(4, style.width * 2.4)
        const id = `agent-hatch-${scene.name.replace(/\W+/g, '-')}-${o.id}`
        const pattern = document.createElementNS(SVG, 'pattern')
        pattern.setAttribute('id', id)
        pattern.setAttribute('patternUnits', 'userSpaceOnUse')
        pattern.setAttribute('width', String(gap))
        pattern.setAttribute('height', String(gap))
        pattern.setAttribute('patternTransform', 'rotate(45)')
        const line = document.createElementNS(SVG, 'line')
        line.setAttribute('x1', '0')
        line.setAttribute('y1', '0')
        line.setAttribute('x2', '0')
        line.setAttribute('y2', String(gap))
        line.setAttribute('stroke', hex(style.hatch))
        line.setAttribute('stroke-width', String(r2(Math.max(1, style.width * 0.5))))
        pattern.appendChild(line)
        defs.appendChild(pattern)
        fill = `url(#${id})`
      }
      el.setAttribute('fill', fill)
      const dash = style.dash?.length && style.dash.some((v) => v > 0) ? style.dash.map(r2) : null
      if (dash) el.setAttribute('stroke-dasharray', dash.join(' '))
      el.setAttribute('stroke', hex(style.color))
      el.setAttribute('stroke-width', String(style.width))
      el.setAttribute('stroke-linecap', 'round')
      el.setAttribute('stroke-linejoin', 'round')
      root.appendChild(el)
      paths.set(o.id, { el, length: null, d: o.d!, pattern: dash, look: null })
    }
    if (defs.childNodes.length) svg.insertBefore(defs, root)
    // The ink canvas above the shapes, as the app's board (Board.tsx: ink is on the canvas over the content layer).
    if (inks.length || scene.learner?.length) {
      canvas = document.createElement('canvas')
      canvas.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none')
    }
    invite = document.createElement('div')
    invite.className = styles.invite
    invite.innerHTML =
      `<button type="button" class="${styles.speaker}" aria-label="Turn on the voice"><span class="${styles.ring}"></span><span class="${styles.ring}"></span>${VOLUME}</button>` +
      `<span class="${styles.label}">Press to hear Claude explain it</span><button type="button" class="${styles.hide}">Hide</button>`
    invite.querySelector(`.${styles.speaker}`)!.addEventListener('click', () => setVoice(true))
    invite.querySelector(`.${styles.hide}`)!.addEventListener('click', () => {
      voice.dismissed = true
      refreshVoice()
    })
    refreshVoice()
    // Each path's length, measured in a document (a detached path has none in every browser) but out of sight; the
    // nodes leave it again until mount.
    const shelf = document.createElement('div')
    shelf.setAttribute('style', 'position:fixed;left:-10000px;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none')
    shelf.appendChild(svg)
    document.body.appendChild(shelf)
    for (const p of paths.values()) p.length = p.el.getTotalLength()
    svg.remove()
    shelf.remove()
  }

  /**
   * The learner's ink never changes in the scene, so it is drawn once into an image of its own, which each frame
   * places under the view. Drawn stroke by stroke in each frame, its few thousand pressure pieces cost about 10 ms of
   * each frame, and on Firefox's GPU canvas the first such frame stalled for about 300 ms (founder, 2026-11-08).
   * The image is drawn on the CPU (willReadFrequently), then turned into a bitmap that the GPU keeps. It is drawn
   * again only for a zoom it would be too coarse for, or much too fine.
   */
  const learner = scene.learner ?? []
  const pad = Math.max(0, ...learner.map((s) => s.width))
  const bounds = learner.length
    ? learner.reduce(
        (b, s) => {
          for (const [x, y] of s.points) {
            b.x0 = Math.min(b.x0, x - pad)
            b.y0 = Math.min(b.y0, y - pad)
            b.x1 = Math.max(b.x1, x + pad)
            b.y1 = Math.max(b.y1, y + pad)
          }
          return b
        },
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      )
    : null
  /** The image: its pixels per board point, and what a frame draws (the bitmap once it is made). */
  let baked: { scale: number; src: CanvasImageSource } | null = null
  /** Pixels on the side of the image at most (a GPU texture's limit on most devices). */
  const BAKE_MAX = 4096
  const learnerInk = (c: CanvasRenderingContext2D, scale: number): void => {
    if (!bounds) return
    const bw = bounds.x1 - bounds.x0
    const bh = bounds.y1 - bounds.y0
    const want = Math.min(scale, BAKE_MAX / bw, BAKE_MAX / bh)
    if (!baked || want > baked.scale * 1.05 || want < baked.scale / 2) {
      const bake = document.createElement('canvas')
      bake.width = Math.max(1, Math.ceil(bw * want))
      bake.height = Math.max(1, Math.ceil(bh * want))
      const b = bake.getContext('2d', { willReadFrequently: true })
      if (!b) return
      b.lineCap = 'round'
      b.lineJoin = 'round'
      b.setTransform(want, 0, 0, want, -bounds.x0 * want, -bounds.y0 * want)
      for (const stroke of learner) drawStroke(b, { points: stroke.points, color: stroke.color, width: stroke.width, tool: stroke.tool }, 0, 1)
      const made = { scale: want, src: bake as CanvasImageSource }
      baked = made
      if (typeof createImageBitmap === 'function')
        void createImageBitmap(bake)
          .then((bitmap) => {
            if (baked === made) made.src = bitmap
          })
          .catch(() => undefined)
    }
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(baked.src, bounds.x0, bounds.y0, bw, bh)
  }

  /** The ink at t, as live/player.ts objectLook shows it: each stroke revealed by its range of the draw value, under the object's matrix. */
  const drawInk = (el: HTMLCanvasElement, lw: number, lh: number, zoom: number, view: Matrix, t: number): void => {
    const px = zoom * (window.devicePixelRatio || 1)
    const width = Math.max(1, Math.round(lw * px))
    const height = Math.max(1, Math.round(lh * px))
    if (el.width !== width || el.height !== height) {
      el.width = width
      el.height = height
    }
    const c = el.getContext('2d')
    if (!c) return
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, width, height)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    const sx = width / lw
    const sy = height / lh
    // The learner's own ink first: it was on the board before the scene.
    c.setTransform(sx * view[0], 0, 0, sy * view[3], sx * view[4], sy * view[5])
    learnerInk(c, sx * view[0])
    for (const { o, ink, ranges: shares, color } of inks) {
      if (before(o, t)) continue
      const drawn = Math.max(0, Math.min(1, tl.value(o.id, 'draw', t)))
      const fill = tl.value(o.id, 'fill', t)
      const alpha = Math.max(0, Math.min(1, tl.value(o.id, 'opacity', t))) * o.style!.opacity
      if ((drawn <= 0 && fill <= 0) || alpha <= 0.001) continue
      const m = multiply(view, tl.matrix(o.id, t))
      c.setTransform(sx * m[0], sy * m[1], sx * m[2], sy * m[3], sx * m[4], sy * m[5])
      ink.strokes.forEach((points, i) => {
        const [a, b] = shares[i]
        const share = b > a ? Math.max(0, Math.min(1, (drawn - a) / (b - a))) : drawn >= b ? 1 : 0
        if (share <= 0) return
        const shown = share < 1 ? revealPoints(points, share) : points
        if (shown.length) drawStroke(c, { points: shown, color, width: ink.width, tool: ink.tool }, 0, alpha, points)
      })
    }
  }

  const draw = (_c: CanvasRenderingContext2D, w: number, h: number, t: number): void => {
    // Before mount (the shell's offscreen draw): build the material, for the first mount to only append it.
    if (!svg) prepare()
    if (!host || !root) return
    // The window's scale and the room the panel leaves, as the other use cases (gps.ts).
    if (laid?.w !== w || laid.h !== h) laid = null
    const lw = laid ? laid.lw : host.clientWidth || w
    const lh = laid ? laid.lh : host.clientHeight || h
    const s = w / lw
    const phone = lw < 760
    const below = PILL_ROOM / s + 14
    panel?.update(t, phone, below)
    if (!laid) {
      // The window's own zoom on the page (the shell scales it), so the ink canvas has a pixel per device pixel.
      const zoom = host.getBoundingClientRect().width / lw || 1
      laid = { w, h, lw, lh, panelH: panel?.el.offsetHeight ?? 0, zoom }
      // The invite in the middle of the whole app window (founder: the shell's centre, not the board's), in the host's
      // own px. The page's scroll moves both alike, so only a new layout moves it.
      const shell = host.closest('[data-shell-frame]')?.firstElementChild
      if (shell) {
        const hr = host.getBoundingClientRect()
        const wr = shell.getBoundingClientRect()
        invite!.style.left = `${(wr.left + wr.width / 2 - hr.left) / zoom}px`
        invite!.style.top = `${(wr.top + wr.height / 2 - hr.top) / zoom}px`
      }
    }
    const { panelH, zoom } = laid
    // The agent's view is the board it drew for, as its camera moves it: on a phone, the board above the panel.
    const rh = phone ? lh - (panelH + below + 12) : lh
    const v = viewAt(t)
    const k = Math.min(lw / v.width, rh / v.height)
    const ox = (lw - v.width * k) / 2 - v.x * k
    const oy = (rh - v.height * k) / 2 - v.y * k
    const matrix = `matrix(${k} 0 0 ${k} ${ox} ${oy})`
    if (matrix !== rootShown) {
      rootShown = matrix
      root.setAttribute('transform', matrix)
    }

    for (const o of shapes) {
      const p = paths.get(o.id)!
      const style = o.style!
      const drawn = tl.value(o.id, 'draw', t)
      const fill = tl.value(o.id, 'fill', t)
      const opacity = Math.max(0, Math.min(1, tl.value(o.id, 'opacity', t))) * style.opacity
      if (before(o, t) || (drawn <= 0 && fill <= 0) || opacity <= 0.001) {
        if (p.look !== 'none') p.el.style.display = 'none'
        p.look = 'none'
        continue
      }
      const m = tl.matrix(o.id, t)
      const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
      // A changing shape: its sample of now until its last change, then its end d.
      const d = o.samples?.length && t < (o.lastChange ?? scene.duration) ? sampleD(o.samples, t) : o.d!
      if (d !== p.d) {
        p.el.setAttribute('d', d)
        p.d = d
        p.length = null
      }
      let dash = ''
      let offset = ''
      if (drawn < 1) {
        p.length ??= p.el.getTotalLength()
        ;({ dash, offset } = revealDash(p.length, p.length * Math.max(0, drawn), p.pattern))
      }
      const baseFill = style.fillOpacity ?? 1
      const look = [opacity < 1 ? String(opacity) : '', identity ? '' : `matrix(${m.join(' ')})`, dash, offset, String(fill >= 1 ? baseFill : baseFill * Math.max(0, fill))]
      const key = look.join('|')
      if (key === p.look) continue
      p.look = key
      p.el.style.display = ''
      p.el.style.opacity = look[0]
      if (identity) p.el.removeAttribute('transform')
      else p.el.setAttribute('transform', look[1])
      p.el.style.strokeDasharray = dash
      p.el.style.strokeDashoffset = offset
      p.el.style.fillOpacity = look[4]
    }
    if (canvas) drawInk(canvas, lw, lh, zoom, [k, 0, 0, k, ox, oy], t)
  }

  return {
    duration: scene.duration,
    draw,
    lag,
    hush() {
      // The shell holds this scene's frame (the next request is typed) or fades it out: its voice stops now.
      stop()
      owner = null
    },
    mount(el) {
      host = el
      laid = null
      resized?.observe(el)
      if (!svg) prepare()
      el.appendChild(svg!)
      if (canvas) el.appendChild(canvas)
      if (panel) el.appendChild(panel.el)
      el.append(invite!)
      member.refresh()
      lastT = -1
      owner = null
      skipped.clear()
    },
    unmount() {
      // Only this scene's audio stops: the visitor's voice choice stays for the next scene.
      stop()
      owner = null
      svg?.remove()
      canvas?.remove()
      panel?.el.remove()
      invite?.remove()
      if (host) resized?.unobserve(host)
      host = null
    }
  }
}
