'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from './hero/tools'
import { ToolPill } from './ToolPill'
import { nextStep, shellSizes } from '@/lib/shell-steps'
import { USE_CASES, type Animation, type CreateAnimation } from './usecases'
import styles from './AppShell.module.css'

/** The other boards in the sidebar, after the use cases' boards (newest edit on top). */
const OTHER_BOARDS: [string, string][] = [
  ['Attention', '1h'],
  ['Muscle', '4d'],
  ['How hearing works', '4d'],
  ['Earth', '1w'],
  ['Exploration', '1w']
]
const USE_CASE_AGES = ['2m', '14m', '21m']

/** The phone layout's window, in CSS px before it is scaled to the screen (AppShell.module.css). */
const PHONE_WINDOW_W = 540
/** A switch is one crossfade (ms): the old scene fades out while the new one fades in from its start. */
const CROSSFADE = 320

/**
 * A shell of the app under the hero (decision D12): the window, the sidebar, the top bar and the
 * board controls in the app's look. Nothing in it works. Its board is a canvas that plays one use
 * case's animation (components/usecases); while the visitor scrolls, the shell stays in the middle
 * of the viewport and the use cases change. The hero's board layer (Board.tsx) paints over it.
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
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const section = sectionRef.current
    const track = trackRef.current
    const stage = stageRef.current
    const frame = frameRef.current
    const inner = innerRef.current
    const board = boardRef.current
    const canvasA = canvasRef.current
    const canvasB = canvas2Ref.current
    if (!section || !track || !stage || !frame || !inner || !board || !canvasA || !canvasB) return
    const ctxA = canvasA.getContext('2d')
    const ctxB = canvasB.getContext('2d')
    if (!ctxA || !ctxB) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    /**
     * One animation instance per use case, made when its module loads and drawn once offscreen
     * (its ink is built and baked then, not in the frame of a switch). An animation depends only
     * on t, so the same instance plays again from t = 0 at each switch.
     */
    const anims: (Animation | null)[] = USE_CASES.map(() => null)
    let loading = false

    /** Two canvases: the scene now shown (front) and the one fading out (back). */
    interface Layer {
      canvas: HTMLCanvasElement
      ctx: CanvasRenderingContext2D
      index: number
      startAt: number
      /** The opacity this layer had when the crossfade began. */
      from: number
      opacity: number
    }
    let front: Layer = { canvas: canvasA, ctx: ctxA, index: 0, startAt: performance.now(), from: 0, opacity: 0 }
    let back: Layer = { canvas: canvasB, ctx: ctxB, index: -1, startAt: 0, from: 0, opacity: 0 }
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
      if (!anim || !w || !h || layer.opacity <= 0) return
      c.setTransform(scale, 0, 0, scale, 0, 0)
      anim.draw(c, w, h, still ? anim.duration : (now - layer.startAt) / 1000)
    }

    const paint = (now: number): void => {
      const k = still ? 1 : Math.min(1, (now - fadeAt) / CROSSFADE)
      const eased = k * k * (3 - 2 * k)
      front.opacity = front.from + (1 - front.from) * eased
      back.opacity = back.from * (1 - eased)
      for (const layer of [front, back]) {
        drawLayer(layer, now)
        layer.canvas.style.opacity = String(layer.opacity)
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
     * Switch to use case `i`: it starts from t = 0 on the layer that shows less now, and fades in
     * while the other fades out from where it is. Both scroll directions are the same.
     */
    const show = (i: number): void => {
      target = i
      setIndex(i)
      const now = performance.now()
      paint(now)
      const [out, into] = front.opacity >= back.opacity ? [front, back] : [back, front]
      out.from = out.opacity
      into.index = i
      into.startAt = now
      into.from = 0
      into.opacity = 0
      into.canvas.style.opacity = '0'
      front = into
      back = out
      fadeAt = now
      kick()
    }

    // ---------- Which use case: the third of the sticky phase the viewport's centre is in (lib/shell-steps.ts) ----------
    const onScroll = (): void => {
      const { winH, third } = shellSizes({ track, frame })
      const i = nextStep(winH, third, window.innerHeight / 2 - track.getBoundingClientRect().top, target)
      if (i !== target) show(i)
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
              front.startAt = performance.now()
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
    const seen = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting
      if (onScreen) kick()
    })
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
      onScroll()
      kick()
    })
    sized.observe(board)
    sized.observe(frame)

    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    onScroll()
    return () => {
      near.disconnect()
      seen.disconnect()
      sized.disconnect()
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const current = USE_CASES[index]

  return (
    <section className={styles.section} ref={sectionRef} aria-label="Learning Space at work">
      <div className={styles.track} ref={trackRef} data-shell-track="">
        <div className={styles.stage} ref={stageRef}>
          <div className={styles.frame} ref={frameRef} data-shell-frame="">
            <div className={styles.window} aria-hidden="true">
              <div className={styles.inner} ref={innerRef}>
                <span className={styles.lights}>
                  <i />
                  <i />
                  <i />
                </span>

                <aside className={styles.sidebar}>
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
                  <header className={styles.topbar}>
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

                  <div className={styles.canvas} ref={boardRef}>
                    <canvas className={styles.ink} ref={canvasRef} />
                    <canvas className={styles.ink} ref={canvas2Ref} />
                    <div className={styles.controls}>
                      <ToolPill className={styles.tools} tool="select" lock={false} />
                      <div className={styles.corner}>
                        <span className={styles.tool}>
                          <Icon name="undo" />
                        </span>
                        <span className={styles.tool}>
                          <Icon name="redo" />
                        </span>
                        <span className={styles.gap} />
                        <span className={styles.tool}>
                          <Icon name="minus" />
                        </span>
                        <span className={styles.zoom}>100%</span>
                        <span className={styles.tool}>
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
