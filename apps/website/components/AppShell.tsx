'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from './hero/tools'
import { ToolPill } from './ToolPill'
import { AgentPrompt } from './AgentPrompt'
import { GLIDE, nextStep, shellSizes } from '@/lib/shell-steps'
import { SHELL_PAD } from '@/lib/spacing'
import { SITE_NAME } from '@/lib/site'
import { USE_CASES, type Animation } from './usecases'
import styles from './AppShell.module.css'

/** The other boards in the sidebar, after the use cases' boards (newest edit on top). */
const OTHER_BOARDS: [string, string][] = [
  ['Attention', '1h'],
  ['GPS', '4d'],
  ['How hearing works', '4d'],
  ['Earth', '1w'],
  ['Exploration', '1w']
]
const USE_CASE_AGES = ['2m', '14m', '21m']

/** The phone layout's window, in CSS px before it is scaled to the screen (AppShell.module.css). */
const PHONE_WINDOW_W = 540
/** The chat window's top at the start of its ride, px below the board's top (just under the shell's top bar), and the scroll over which it eases to its stop (AppShell placeChat). */
const CHAT_START = 10
const CHAT_KNEE = 180
/** A switch is one crossfade (ms): the old scene fades out while the new one fades in from its start. */
const CROSSFADE = 320
/** A finished scene holds its last frame this long (s), then plays again (founder, 2026-11-07). */
const REPLAY_GAP = 3

/**
 * Development only: `?scene=<use case id>&t=<seconds>` holds the shell on that use case at that
 * scene time, to look at one frame (the scroll does not change the use case then).
 */
function heldScene(): { index: number; t: number } | null {
  if (process.env.NODE_ENV !== 'development') return null
  const query = new URLSearchParams(window.location.search)
  const index = USE_CASES.findIndex((useCase) => useCase.id === query.get('scene'))
  const t = Number(query.get('t') ?? 0)
  return index >= 0 && Number.isFinite(t) ? { index, t } : null
}

/**
 * A shell of the app under the hero (decision D12): the window, the sidebar, the top bar and the
 * board controls in the app's look. Nothing in it works. Its board is a canvas that plays one use
 * case's scene (components/usecases) once the chat window has typed its request; while the visitor
 * scrolls, the shell stays in the middle of the viewport and the use cases change. The hero's
 * board layer (Board.tsx) paints over it.
 */
export function AppShell() {
  const sectionRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvas2Ref = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const host2Ref = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  /** The use case asked in the agent window now (-1: the shell has not come into view yet). */
  const [asked, setAsked] = useState(-1)
  /** Switch the board to use case i once its request is typed (set by the effect). */
  const showRef = useRef<(i: number) => void>(() => {})

  useEffect(() => {
    const section = sectionRef.current
    const track = trackRef.current
    const stage = stageRef.current
    const frame = frameRef.current
    const inner = innerRef.current
    const board = boardRef.current
    const canvasA = canvasRef.current
    const canvasB = canvas2Ref.current
    const hostA = hostRef.current
    const hostB = host2Ref.current
    if (!section || !track || !stage || !frame || !inner || !board || !canvasA || !canvasB || !hostA || !hostB) return
    const ctxA = canvasA.getContext('2d')
    const ctxB = canvasB.getContext('2d')
    if (!ctxA || !ctxB) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const hold = heldScene()

    /**
     * One animation instance per use case, made when its module loads and drawn once offscreen in
     * idle time (its ink is built and baked then, not in the frame of a switch). An animation depends only
     * on t, so the same instance plays again from t = 0 at each switch.
     */
    const anims: (Animation | null)[] = USE_CASES.map(() => null)
    let loading = false

    /**
     * Two layers: the scene now shown (front) and the one fading out (back). A layer is the ink
     * canvas and, over it, the host of the scene's other material (Animation.mount).
     */
    interface Layer {
      canvas: HTMLCanvasElement
      ctx: CanvasRenderingContext2D
      host: HTMLDivElement
      index: number
      startAt: number
      /** The scene time this layer holds (it is not the one playing: it fades out); null while it plays. */
      frozen: number | null
      /** The opacity this layer had when the crossfade began, and the one it ends at. */
      from: number
      to: number
      opacity: number
      /** What the canvas holds now ('' when empty) and the opacity last written: a frame that changes neither writes nothing. */
      drawn: string
      shown: string
    }
    // The board is empty until the first request is typed.
    let front: Layer = { canvas: canvasA, ctx: ctxA, host: hostA, index: -1, startAt: 0, frozen: null, from: 0, to: 0, opacity: 0, drawn: '', shown: '' }
    let back: Layer = { canvas: canvasB, ctx: ctxB, host: hostB, index: -1, startAt: 0, frozen: null, from: 0, to: 0, opacity: 0, drawn: '', shown: '' }
    /** The host each animation's material is in now: one place at a time, the newest layer that shows it. */
    const mounted = new Map<Animation, HTMLDivElement>()
    const attach = (layer: Layer): void => {
      const anim = layer.index >= 0 ? anims[layer.index] : null
      // Material mounted now has not been drawn yet.
      layer.drawn = ''
      // A layer shows its own scene's material only: what an earlier scene left in its host goes.
      for (const [other, host] of mounted) {
        if (host !== layer.host || other === anim) continue
        other.unmount?.()
        mounted.delete(other)
      }
      if (!anim?.mount || mounted.get(anim) === layer.host) return
      if (mounted.has(anim)) anim.unmount?.()
      anim.mount(layer.host)
      mounted.set(anim, layer.host)
    }
    let fadeAt = performance.now()
    /** The use case the scroll asks for. */
    let target = 0
    let onScreen = false
    let raf = 0
    /** The timer that wakes the loop at the end of a still stretch (tick). */
    let wake = 0
    let w = 0
    let h = 0
    let scale = 1

    /**
     * A layer's scene time now, and its replay's own fade (`seen`, times the layer's opacity). The scene plays, holds
     * its last frame for REPLAY_GAP and fades out over its last CROSSFADE, then fades in again over CROSSFADE and
     * plays from t = 0 (the request is not typed again). `playing`: the scene time runs (its clock may hold it).
     * `next`: seconds until the frame or the fade changes again (0: in each frame; Infinity: only on an event).
     */
    const clock = (layer: Layer, anim: Animation, now: number): { t: number; seen: number; playing: boolean; next: number } => {
      if (hold) return { t: hold.t, seen: 1, playing: false, next: Infinity }
      if (layer.frozen !== null) return { t: layer.frozen, seen: 1, playing: false, next: Infinity }
      if (still) return { t: anim.duration, seen: 1, playing: false, next: Infinity }
      const fade = CROSSFADE / 1000
      const first = anim.duration + REPLAY_GAP
      const played = (now - layer.startAt) / 1000
      // From the first replay on, each cycle starts with its fade in (phase < 0).
      const phase = played < first ? played : ((played - first) % (fade + first)) - fade
      const k = phase < 0 ? (phase + fade) / fade : phase > first - fade ? (first - phase) / fade : 1
      // The replay's hold is a still frame until its fade out. (A voiced line ends by the scene's end, so no voice
      // plays in it: the voice's quiet timer, agent-scene.ts, cuts nothing.)
      const next = phase >= anim.duration && phase < first - fade ? first - fade - phase : 0
      return { t: Math.max(0, Math.min(anim.duration, phase)), seen: k * k * (3 - 2 * k), playing: phase >= 0, next }
    }

    /** Draw a layer's frame, only when it is not the one its canvas holds; returns its replay fade and `next` (clock). */
    const drawLayer = (layer: Layer, now: number): { seen: number; next: number } => {
      const c = layer.ctx
      const anim = layer.index >= 0 ? anims[layer.index] : null
      // A scene that shows on both layers (the step left and come back to) plays on the front one only.
      if (!anim || !w || !h || layer.opacity <= 0 || (layer === back && back.index === front.index)) {
        if (layer.drawn) {
          c.setTransform(1, 0, 0, 1, 0, 0)
          c.clearRect(0, 0, layer.canvas.width, layer.canvas.height)
          layer.drawn = ''
        }
        return { seen: 1, next: Infinity }
      }
      let at = clock(layer, anim, now)
      // The scene's own clock (its voice) may hold it: the scene time, kept here only, moves back by what it says.
      const lag = at.playing ? (anim.lag?.(at.t) ?? 0) : 0
      if (lag > 0) {
        layer.startAt += lag * 1000
        at = clock(layer, anim, now)
      }
      // The canvas's size is in the key: a new bitmap size empties it.
      const look = `${layer.index} ${at.t} ${w} ${h} ${scale}`
      if (look !== layer.drawn) {
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.clearRect(0, 0, layer.canvas.width, layer.canvas.height)
        c.setTransform(scale, 0, 0, scale, 0, 0)
        anim.draw(c, w, h, at.t)
        layer.drawn = look
      }
      return at
    }

    /** Paint both layers; returns the seconds until the next change (as clock's `next`). */
    const paint = (now: number): number => {
      const k = still || hold ? 1 : Math.min(1, (now - fadeAt) / CROSSFADE)
      const eased = k * k * (3 - 2 * k)
      let next = k < 1 ? 0 : Infinity
      for (const layer of [front, back]) {
        layer.opacity = layer.from + (layer.to - layer.from) * eased
        const at = drawLayer(layer, now)
        next = Math.min(next, at.next)
        const seen = String(layer.opacity * at.seen)
        if (seen === layer.shown) continue
        layer.shown = seen
        layer.canvas.style.opacity = seen
        layer.host.style.opacity = seen
      }
      return next
    }

    // The loop rests while nothing changes (a held frame, the replay's hold): a timer wakes it where the change is due,
    // an event (a switch, a resize, the shell back on screen) at once.
    const tick = (now: number): void => {
      raf = 0
      window.clearTimeout(wake)
      wake = 0
      const next = paint(now)
      if (still || !onScreen || document.hidden) return
      if (next <= 0) raf = requestAnimationFrame(tick)
      else if (next < Infinity) wake = window.setTimeout(kick, next * 1000)
    }
    /** Paint again: the loop while the shell is on screen, one frame with reduced motion. */
    const kick = (): void => {
      if (!raf) raf = requestAnimationFrame(tick)
    }

    /**
     * Switch to use case `i` as its request starts to type: it starts from t = 0 on the layer that
     * shows less now, and fades in while the other fades out from the frame it holds. Both scroll
     * directions are the same.
     */
    const show = (i: number): void => {
      target = i
      setIndex(i)
      if (hold && front.index === i) return
      swap(i)
    }

    /** A layer stops playing: its scene time holds where it is and its sound stops now (not when it is no longer drawn). */
    const freeze = (layer: Layer, now: number): void => {
      const anim = layer.index >= 0 ? anims[layer.index] : null
      if (!anim || layer.frozen !== null) return
      // A replay fade in progress is part of what shows: the held frame keeps that opacity (no jump to the layer's).
      const at = clock(layer, anim, now)
      layer.frozen = at.t
      layer.opacity *= at.seen
      anim.hush?.()
    }
    /** Both layers ease from where they are to these opacities over one CROSSFADE. */
    const fadeTo = (now: number, toFront: number, toBack: number): void => {
      for (const layer of [front, back]) layer.from = layer.opacity
      front.to = toFront
      back.to = toBack
      fadeAt = now
      kick()
    }

    /** Fade use case `i`'s scene in while the scene shown now fades out. */
    const swap = (i: number): void => {
      const now = performance.now()
      paint(now)
      const [out, into] = front.opacity >= back.opacity ? [front, back] : [back, front]
      freeze(out, now)
      freeze(into, now)
      into.index = i
      into.startAt = now
      into.frozen = null
      into.opacity = 0
      into.shown = '0'
      into.canvas.style.opacity = '0'
      into.host.style.opacity = '0'
      attach(into)
      front = into
      back = out
      fadeTo(now, 1, 0)
    }

    // ---------- The window glides into its sticky place and out of it (the founder: no hard stop) ----------
    // The window's place has one owner: this code. With motion, the stage is position: fixed
    // (data-glide, AppShell.module.css) and its translate is set from the scroll; the browser
    // never moves it by itself. (A sticky stage plus a correcting translate had two owners: with
    // scrolling on the compositor, as in Firefox, the browser moved it first and the script
    // pulled it back a frame later, so it went up and then down.)
    // It eases over `knee` (K) px of scroll and never moves faster than the page, so against the
    // dot grid and the marks it only ever falls behind, never runs ahead (the founder saw a faster
    // curve as "up, then down"). On the way in its speed falls evenly from the page's to 0: the
    // ease starts when it is K/2 above its rest and covers those K/2 in K px of scroll. On the way
    // out, at the same release point as before, its speed rises evenly from 0 to the page's over
    // K px, and then it stays K/2 behind the track. It follows the scroll, not time. With reduced
    // motion the stage stays sticky and stops plainly.
    let knee = 0
    const measureGlide = (): void => {
      knee = GLIDE * window.innerHeight
    }
    let shown = NaN
    const placeStage = (trackTop: number, trackH: number, winH: number): void => {
      if (still) return
      // Its sticky place: the middle of the viewport.
      const rest = (window.innerHeight - winH) / 2
      // In: u px of scroll left in the ease (it ends K/2 of scroll after the track's own stick point).
      const u = trackTop - rest + knee / 2
      // Out: e px of scroll since the track's own release point.
      const e = rest - (trackTop + trackH - winH)
      const y =
        u >= knee ? trackTop : u > 0 ? rest + (u * u) / (2 * knee) : e >= knee ? trackTop + trackH - winH + knee / 2 : e > 0 ? rest - (e * e) / (2 * knee) : rest
      placeChat(y, winH)
      if (y !== shown) {
        shown = y
        stage.style.translate = `0 ${y}px`
      }
    }

    // ---------- The chat window rides down the shell's left edge as the shell comes in ----------
    // The founder: the chat window (AgentPrompt.tsx) starts inside the shell where the board starts
    // (just under the top bar, on the left), so the question is seen being asked, and it is not
    // in the hero's first screen. As the page scrolls it comes up with the shell, eases to a stop
    // at the place on screen it has when the shell sticks, and stays there while the shell slides
    // up behind it; it is at its lower-left corner place exactly when the shell sticks. On the way
    // out it leaves with the shell. Same owner as the stage: its offset is a function of the
    // stage's place `y` only. The stop is the glide's ease: its speed falls evenly from the page's
    // to 0 over CHAT_KNEE px of scroll, so it never jumps or turns back. Phones keep their place
    // under the shell (no ride); with reduced motion placeStage does not run.
    const chat = stage.querySelector<HTMLElement>('[data-agent-window]')
    let chatShown = NaN

    // ---------- The chat window's overhang below the shell counts as the shell's content (lib/spacing.ts) ----------
    // On a phone the chat window hangs under the shell's window, so the gap to the next section
    // begins at the chat window's bottom. Its height depends on the request, and the request
    // wraps differently at each width, so it is measured here: a hidden copy of the window holds
    // each use case's request in turn, and the largest overhang (CSS px, with the window's turn)
    // goes to --shell-overhang on the page, for the agent section's margin (Sections.module.css).
    // The largest one, so the next section does not move when the use case changes. This is the
    // value's only owner.
    const page = section.parentElement
    let overhang = NaN
    const measureOverhang = (): void => {
      if (!chat || !page) return
      const probe = chat.cloneNode(true) as HTMLElement
      probe.removeAttribute('style')
      probe.removeAttribute('data-agent-window')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.visibility = 'hidden'
      probe.style.pointerEvents = 'none'
      const ghost = probe.querySelector<HTMLElement>('[data-request-ghost]')
      stage.appendChild(probe)
      const frameBottom = frame.getBoundingClientRect().bottom
      let most = 0
      for (const useCase of USE_CASES) {
        if (ghost) ghost.textContent = useCase.request
        most = Math.max(most, probe.getBoundingClientRect().bottom - frameBottom)
      }
      probe.remove()
      const next = Math.ceil(most)
      if (next !== overhang) {
        overhang = next
        page.style.setProperty('--shell-overhang', `${next}px`)
      }
    }
    const placeChat = (y: number, winH: number): void => {
      if (!chat) return
      let ride = 0
      if (!window.matchMedia('(max-width: 719px)').matches) {
        const restTop = chat.offsetTop
        // Its place on screen once the shell sticks.
        const stop = (window.innerHeight - winH) / 2 + restTop
        // The start: the board's top in the stage, plus CHAT_START.
        const start = board.getBoundingClientRect().top - stage.getBoundingClientRect().top + CHAT_START
        // d: how far its top would be below that place if it went on with the shell.
        const d = y + start + CHAT_KNEE / 2 - stop
        const top = stop + (d >= CHAT_KNEE ? d - CHAT_KNEE / 2 : d > 0 ? (d * d) / (2 * CHAT_KNEE) : 0)
        ride = Math.min(0, top - y - restTop)
      }
      if (ride !== chatShown) {
        chatShown = ride
        chat.style.transform = ride ? `translateY(${ride}px)` : ''
      }
    }

    // ---------- Which use case: the third of the sticky phase the viewport's centre is in (lib/shell-steps.ts) ----------
    const onScroll = (): void => {
      const { winH, third } = shellSizes({ track, frame })
      const trackTop = track.getBoundingClientRect().top
      placeStage(trackTop, track.offsetHeight, winH)
      const i = nextStep(winH, third, window.innerHeight / 2 - trackTop, target)
      if (i !== target && !hold) ask(i)
    }

    /**
     * Build an animation's ink and material once, offscreen, at the board's size, in idle time after its module
     * loads: the first switch to it then only shows it (a build in that frame was the jank at its start).
     */
    let live = true
    const idle = (run: () => void): void => {
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 })
      else setTimeout(run, 200)
    }
    const warm = (anim: Animation): void =>
      idle(() => {
        if (!live || !w || !h) return
        const scratch = document.createElement('canvas')
        scratch.width = canvasA.width
        scratch.height = canvasA.height
        const c = scratch.getContext('2d')
        if (!c) return
        c.setTransform(scale, 0, 0, scale, 0, 0)
        anim.draw(c, w, h, anim.duration)
        // That draw set the scene's material (agent-scene.ts) for its last frame: a layer that shows it draws its own again.
        for (const layer of [front, back]) if (anims[layer.index] === anim) layer.drawn = ''
        kick()
      })

    // ---------- The modules load when the section comes near ----------
    const load = (): void => {
      if (loading) return
      loading = true
      USE_CASES.forEach((useCase, i) => {
        useCase
          .load()
          .then((module) => {
            const anim = module.default()
            warm(anim)
            anims[i] = anim
            if (i === front.index) {
              attach(front)
              kick()
            }
          })
          .catch(() => {
            // A module that fails to load leaves its board empty; the shell still shows.
          })
      })
    }
    const near = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), { rootMargin: '100% 0px' })
    near.observe(section)

    // ---------- The loop runs only while the window is on screen ----------
    let asked = -1
    /** The person asks for use case i in the agent window; the board switches as the request starts to type (showRef). */
    const ask = (i: number): void => {
      target = i
      asked = i
      setAsked(i)
    }
    showRef.current = (i: number): void => {
      if (i === target) show(i)
    }
    const seen = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting
      if (onScreen) kick()
    })
    // The first request is typed when half the window is in view, not when it first peeks under
    // the hero, and only once the chat window is in full view (the question is seen being asked).
    const inSight = new Map<Element, boolean>()
    const inView = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inSight.set(e.target, e.intersectionRatio >= (e.target === frame ? 0.5 : 0.9))
        if (asked >= 0 || !inSight.get(frame) || (chat && !inSight.get(chat))) return
        ask(target)
        inView.disconnect()
      },
      { threshold: [0.5, 0.9] }
    )
    inView.observe(frame)
    if (chat) inView.observe(chat)
    seen.observe(frame)
    const onVisibility = (): void => {
      if (!document.hidden && onScreen) kick()
    }

    // ---------- Sizes: the phone window's scale, and the canvas bitmap ----------
    // The window's inside is laid out bigger and scaled down (--s, AppShell.module.css), as a
    // screenshot of a bigger window; the animation draws in the board's size on screen.
    let boardW = 0
    let boardH = 0
    const fitCanvas = (): void => {
      const s = inner.offsetWidth ? frame.clientWidth / inner.offsetWidth : 1
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = boardW * s
      h = boardH * s
      const bw = Math.max(1, Math.round(w * dpr))
      const bh = Math.max(1, Math.round(h * dpr))
      for (const canvas of [canvasA, canvasB])
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw
          canvas.height = bh
        }
      scale = w ? bw / w : 1
    }
    const sized = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === board) {
          boardW = entry.contentRect.width
          boardH = entry.contentRect.height
        } else if (entry.target === frame) {
          section.style.setProperty('--z', String(Math.min(1, frame.clientWidth / PHONE_WINDOW_W)))
        }
      }
      measureOverhang()
      fitCanvas()
      measureGlide()
      onScroll()
      kick()
    })
    sized.observe(board)
    sized.observe(frame)
    // The request's font can arrive after the first layout and wrap the bubble differently.
    if (chat) sized.observe(chat)
    void document.fonts?.ready.then(() => live && measureOverhang())

    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    measureGlide()
    onScroll()
    if (hold) {
      ask(hold.index)
      show(hold.index)
      load()
    }
    // From now on the script places the stage (placeStage); before this it was sticky.
    if (!still) section.dataset.glide = ''
    return () => {
      live = false
      delete section.dataset.glide
      page?.style.removeProperty('--shell-overhang')
      stage.style.translate = ''
      const chatEl = stage.querySelector<HTMLElement>('[data-agent-window]')
      if (chatEl) chatEl.style.transform = ''
      near.disconnect()
      seen.disconnect()
      inView.disconnect()
      sized.disconnect()
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(wake)
      for (const anim of mounted.keys()) anim.unmount?.()
    }
  }, [])

  const current = USE_CASES[index]

  return (
    <section className={styles.section} ref={sectionRef} aria-label={`${SITE_NAME} at work`} style={{ '--pad-desk': SHELL_PAD.desk, '--pad-phone': SHELL_PAD.phone } as CSSProperties}>
      <div className={styles.track} ref={trackRef} data-shell-track="">
        <div className={styles.stage} ref={stageRef}>
          <AgentPrompt index={asked} onStart={(i) => showRef.current(i)} />
          <div className={styles.frame} ref={frameRef} data-shell-frame="">
            <div className={styles.window}>
              <div className={styles.inner} ref={innerRef}>
                <span className={styles.lights} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>

                <aside className={styles.sidebar} aria-hidden="true">
                  <div className={styles.strip}>
                    <TitleLead />
                  </div>
                  <div className={styles.actions}>
                    <div className={`${styles.row} ${styles.action}`}>
                      <Icon name="squarePen" />
                      <span className={styles.name}>New board</span>
                      <span className={styles.hint}>⌘N</span>
                    </div>
                    <div className={`${styles.row} ${styles.action}`}>
                      <Icon name="search" />
                      <span className={styles.name}>Search boards</span>
                      <span className={styles.hint}>⌘K</span>
                    </div>
                  </div>
                  <div className={styles.list}>
                    <div className={styles.heading}>Boards</div>
                    {USE_CASES.map((useCase, i) => (
                      <div key={useCase.id} className={i === index ? `${styles.row} ${styles.active}` : styles.row}>
                        <span className={styles.name}>{useCase.board}</span>
                        {i === index ? (
                          <span className={styles.more}>
                            <Icon name="ellipsis" stroke={2} />
                          </span>
                        ) : (
                          <span className={styles.time}>{USE_CASE_AGES[i]}</span>
                        )}
                      </div>
                    ))}
                    {OTHER_BOARDS.map(([name, age]) => (
                      <div key={name} className={styles.row}>
                        <span className={styles.name}>{name}</span>
                        <span className={styles.time}>{age}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.footer}>
                    <div className={styles.folder}>
                      <Icon name="folder" />
                      <span className={styles.name}>learning-space</span>
                      <span className={styles.chevrons}>
                        <Icon name="chevronsUpDown" />
                      </span>
                    </div>
                  </div>
                </aside>

                <div className={styles.main}>
                  <header className={styles.topbar} aria-hidden="true">
                    <div className={styles.title}>
                      <span className={styles.phoneLead}>
                        <TitleLead />
                      </span>
                      <span key={current.id} className={styles.board}>
                        {current.board}
                      </span>
                    </div>
                    <span className={styles.agent}>
                      <span key={current.id} className={styles.dot} />
                      Claude Code
                    </span>
                  </header>

                  <div className={styles.canvas} ref={boardRef} role="img" aria-label={`${current.board} board: ${current.request}`}>
                    <canvas className={styles.ink} ref={canvasRef} />
                    <canvas className={styles.ink} ref={canvas2Ref} />
                    <div className={styles.scene} ref={hostRef} />
                    <div className={styles.scene} ref={host2Ref} />
                    <div className={styles.controls}>
                      <ToolPill className={styles.tools} tool="select" lock={false} />
                      <div className={styles.corner}>
                        <span className={styles.tool} aria-hidden="true">
                          <Icon name="undo" />
                        </span>
                        <span className={styles.tool} aria-hidden="true">
                          <Icon name="redo" />
                        </span>
                        <span className={styles.gap} />
                        <span className={styles.tool} aria-hidden="true">
                          <Icon name="minus" />
                        </span>
                        <span className={styles.zoom} aria-hidden="true">
                          100%
                        </span>
                        <span className={styles.tool} aria-hidden="true">
                          <Icon name="plus" />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** Back, Forward and the sidebar button (the app's TitleLead). */
function TitleLead() {
  return (
    <span className={styles.lead}>
      <span className={styles.titleButton}>
        <Icon name="chevronLeft" stroke={1.4} />
      </span>
      <span className={`${styles.titleButton} ${styles.disabled}`}>
        <Icon name="chevronRight" stroke={1.4} />
      </span>
      <span className={`${styles.titleButton} ${styles.panel}`}>
        <Icon name="panelLeft" />
      </span>
    </span>
  )
}
