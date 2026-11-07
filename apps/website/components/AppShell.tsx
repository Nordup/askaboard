'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from './hero/tools'
import { ToolPill } from './ToolPill'
import { AgentPrompt } from './AgentPrompt'
import { GLIDE, nextStep, shellSizes } from '@/lib/shell-steps'
import { SHELL_PAD } from '@/lib/spacing'
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
     * One animation instance per use case, made when its module loads and drawn once offscreen
     * (its ink is built and baked then, not in the frame of a switch). An animation depends only
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
      /** The opacity this layer had when the crossfade began. */
      from: number
      opacity: number
    }
    // The board is empty until the first request is typed.
    let front: Layer = { canvas: canvasA, ctx: ctxA, host: hostA, index: -1, startAt: 0, from: 0, opacity: 0 }
    let back: Layer = { canvas: canvasB, ctx: ctxB, host: hostB, index: -1, startAt: 0, from: 0, opacity: 0 }
    /** The host each animation's material is in now: one place at a time, the newest layer that shows it. */
    const mounted = new Map<Animation, HTMLDivElement>()
    const attach = (layer: Layer): void => {
      const anim = layer.index >= 0 ? anims[layer.index] : null
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
    let w = 0
    let h = 0
    let scale = 1

    const drawLayer = (layer: Layer, now: number): void => {
      const c = layer.ctx
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, layer.canvas.width, layer.canvas.height)
      const anim = layer.index >= 0 ? anims[layer.index] : null
      // A scene that shows on both layers (the step left and come back to) plays on the front one only.
      if (!anim || !w || !h || layer.opacity <= 0 || (layer === back && back.index === front.index)) return
      c.setTransform(scale, 0, 0, scale, 0, 0)
      // The scene plays, holds its last frame for REPLAY_GAP, and plays again from the start (the request is not typed again).
      const played = (now - layer.startAt) / 1000
      const t = hold ? hold.t : still ? anim.duration : Math.min(anim.duration, played % (anim.duration + REPLAY_GAP))
      anim.draw(c, w, h, t)
    }

    const paint = (now: number): void => {
      const k = still || hold ? 1 : Math.min(1, (now - fadeAt) / CROSSFADE)
      const eased = k * k * (3 - 2 * k)
      front.opacity = front.from + (1 - front.from) * eased
      back.opacity = back.from * (1 - eased)
      for (const layer of [front, back]) {
        drawLayer(layer, now)
        layer.canvas.style.opacity = String(layer.opacity)
        layer.host.style.opacity = String(layer.opacity)
      }
    }

    const tick = (now: number): void => {
      raf = 0
      paint(now)
      if (!still && onScreen && !document.hidden) raf = requestAnimationFrame(tick)
    }
    /** Paint again: the loop while the shell is on screen, one frame with reduced motion. */
    const kick = (): void => {
      if (!raf) raf = requestAnimationFrame(tick)
    }

    /**
     * Switch to use case `i` once its request is typed: it starts from t = 0 on the layer that
     * shows less now, and fades in while the other fades out from where it is. Both scroll
     * directions are the same.
     */
    const show = (i: number): void => {
      target = i
      setIndex(i)
      if (hold && front.index === i) return
      swap(i)
    }

    /** Fade use case `i`'s scene in (i = -1: an empty board) while the scene shown now fades out. */
    const swap = (i: number): void => {
      const now = performance.now()
      paint(now)
      const [out, into] = front.opacity >= back.opacity ? [front, back] : [back, front]
      out.from = out.opacity
      into.index = i
      into.startAt = now
      into.from = 0
      into.opacity = 0
      into.canvas.style.opacity = '0'
      into.host.style.opacity = '0'
      attach(into)
      front = into
      back = out
      fadeAt = now
      kick()
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

    /** Build an animation's ink once, offscreen, at the board's size. */
    const warm = (anim: Animation): void => {
      if (!w || !h) return
      const scratch = document.createElement('canvas')
      scratch.width = canvasA.width
      scratch.height = canvasA.height
      const c = scratch.getContext('2d')
      if (!c) return
      c.setTransform(scale, 0, 0, scale, 0, 0)
      anim.draw(c, w, h, anim.duration)
    }

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
    /** The person asks for use case i in the agent window; the board switches when it is typed (showRef). */
    const ask = (i: number): void => {
      target = i
      asked = i
      setAsked(i)
      // The board clears with the chat window; the new scene plays once the request is typed.
      if (front.index >= 0) swap(-1)
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
        } else {
          section.style.setProperty('--z', String(Math.min(1, frame.clientWidth / PHONE_WINDOW_W)))
        }
      }
      fitCanvas()
      measureGlide()
      onScroll()
      kick()
    })
    sized.observe(board)
    sized.observe(frame)

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
      delete section.dataset.glide
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
      for (const anim of mounted.keys()) anim.unmount?.()
    }
  }, [])

  const current = USE_CASES[index]

  return (
    <section className={styles.section} ref={sectionRef} aria-label="Learning Space at work" style={{ '--pad-desk': SHELL_PAD.desk, '--pad-phone': SHELL_PAD.phone } as CSSProperties}>
      <div className={styles.track} ref={trackRef} data-shell-track="">
        <div className={styles.stage} ref={stageRef}>
          <AgentPrompt index={asked} onDone={(i) => showRef.current(i)} />
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
