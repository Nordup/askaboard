import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Minus, Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import { useSceneState } from '../live/state'
import { lookOf, useBoardStories, versionOnBoard } from '../live/stories'
import { boardNodes, hidePanel, openedFromPill, sceneStarted, setPanelScene, useReading } from '../live/reading'
import { fadeMs, tokenMs, usePresence } from '../lib/presence'

/*
 * The reading panel (decision B19): one scene at a time, in a small frame that floats over the
 * board. The learner drags it by its header and it stays there. It shows a step bar (one segment
 * per step: click to play from it, hover for its name), the reading view (the scene's lines scroll
 * past a light that follows the reading point, ReadingView below) and a footer with one status and
 * the playback buttons. It appears when a scene plays and fades a few seconds after the scene ends (not while
 * the pointer is on it). Minus hides it into the scene pill; the pill's menu opens any scene of
 * the board in it, from the scene records, in its ended state.
 *
 * The one exception to "UI does not cover the board" (design-system.md).
 */

/** How long the panel stays after its scene ended (while the pointer is not on it). */
const LINGER_MS = 4000

// ---------- Position (remembered in this window) ----------

/** Distance from the canvas side it is nearer to, and from the top. */
interface Position {
  side: 'left' | 'right'
  x: number
  y: number
}

const POSITION_KEY = 'ls.scriptPanel.position'

function readPosition(): Position | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as Position | null
    if (value && (value.side === 'left' || value.side === 'right') && Number.isFinite(value.x) && Number.isFinite(value.y)) return value
  } catch {
    // no stored position: the default
  }
  return null
}

function writePosition(value: Position): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(value))
  } catch {
    // storage blocked: the position lasts until the window closes
  }
}

function cssPx(element: Element, name: string): number {
  const value = parseFloat(getComputedStyle(element).getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

/** Where the panel of this width goes in its canvas for a wanted position: left, top and the height it may take (room). */
function placeOf(canvas: HTMLElement, width: number, wanted: Position | null): { left: number; top: number; room: number } {
  const margin = cssPx(canvas, '--space-3')
  const header = cssPx(canvas, '--script-panel-header')
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  // Never over the tool palette: the panel ends a margin above it.
  const palette = canvas.querySelector<HTMLElement>('.palette')
  const floor = palette ? palette.offsetTop - margin : H - margin
  const at = wanted ?? { side: 'right', x: margin, y: margin }
  const rawLeft = at.side === 'left' ? at.x : W - width - at.x
  const left = Math.round(Math.max(margin, Math.min(W - width - margin, rawLeft)))
  const top = Math.round(Math.max(margin, Math.min(floor - header - 2, at.y)))
  return { left, top, room: Math.max(header + 2, floor - top) }
}

/** The border of .script-panel (app.css), top and bottom each. */
const PANEL_BORDER = 1

/**
 * The window rect (client CSS px) that the panel takes when it shows: at its
 * full height, also before the first scene and while it is hidden, because it
 * appears when a scene plays and grows with its lines. Null when no board is open.
 */
export function scriptPanelArea(): { left: number; top: number; right: number; bottom: number } | null {
  const canvas = document.querySelector<HTMLElement>('.canvas')
  if (!canvas?.querySelector('.board')) return null
  // The panel's CSS width: min(--script-panel-width, 100% - 2 × --space-3).
  const width = Math.min(cssPx(canvas, '--script-panel-width'), canvas.clientWidth - 2 * cssPx(canvas, '--space-3'))
  const { left, top, room } = placeOf(canvas, width, readPosition())
  const full = cssPx(canvas, '--script-panel-header') + cssPx(canvas, '--script-panel-body-max') + 2 * PANEL_BORDER
  const origin = canvas.getBoundingClientRect()
  return { left: origin.left + left, top: origin.top + top, right: origin.left + left + width, bottom: origin.top + top + Math.min(room, full) }
}



// ---------- What the panel shows ----------

interface PanelStep {
  name: string
  at: number
  dur: number
  /** Its lines: indexes into the view's lines. */
  lines: number[]
}

interface PanelView {
  /** The committed scene (a replay shows the scene it replays). */
  scene: string
  name: string
  steps: PanelStep[]
  live: boolean
  paused: boolean
  pausedBy: string | null
  /** The app can play this version again (the player holds it). */
  canPlay: boolean
  /** The step that shows (0-based); in the ended state the last one. */
  step: number
  /** The share of the current step played, 0..1 (live only). */
  progress: number
  /** Every line of the scene, in order. */
  lines: string[]
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Steps with their lengths and lines; a scene with no step is one segment with every line. */
function panelSteps(name: string, steps: Array<{ name: string; at: number; lines: number[] }>, duration: number, lineCount: number): PanelStep[] {
  if (!steps.length) return [{ name, at: 0, dur: duration, lines: Array.from({ length: lineCount }, (_, i) => i) }]
  return steps.map((step, i) => ({ name: step.name, at: step.at, dur: Math.max(0, (steps[i + 1]?.at ?? duration) - step.at), lines: step.lines }))
}

const PAUSE_WORDS: Record<string, string> = { 'learner drawing': 'Paused while you draw', 'pause step': 'Paused at a pause' }

// ---------- The panel ----------

export function ScriptPanel() {
  const scene = useSceneState()
  const stories = useBoardStories()
  const reading = useReading()
  const liveId = scene.playing ? scene.sceneOf : null

  // A scene that starts after nothing played shows the panel (also after a hide).
  const wasLive = useRef(false)
  useEffect(() => {
    if (liveId && !wasLive.current) sceneStarted()
    wasLive.current = !!liveId
  }, [liveId])

  // The scene that just ended stays a few seconds (longer while the pointer is on the panel).
  const lastLive = useRef<{ scene: string; name: string; steps: Array<{ name: string; at: number; lines: number[] }>; lines: Array<{ text: string }>; duration: number } | null>(null)
  if (liveId) lastLive.current = { scene: liveId, name: scene.sceneName ?? 'Scene', steps: scene.steps.map((step) => ({ name: step.name, at: step.at_s, lines: step.lines })), lines: scene.cues.map((cue) => ({ text: cue.text })), duration: scene.duration }
  const [ended, setEnded] = useState<string | null>(null)
  const [hover, setHover] = useState(false)
  useEffect(() => {
    setEnded(liveId ? null : (lastLive.current?.scene ?? null))
  }, [liveId])
  useEffect(() => {
    if (!ended || hover) return
    const timer = setTimeout(() => setEnded(null), LINGER_MS)
    return () => clearTimeout(timer)
  }, [ended, hover])

  // A scene chosen from the pill's menu wins until a new scene starts after nothing played.
  const shownId = reading.hidden ? null : (reading.chosen ?? liveId ?? ended)
  useEffect(() => setPanelScene(shownId), [shownId])

  let view: PanelView | null = null
  if (shownId && liveId === shownId) {
    const steps = panelSteps(scene.sceneName ?? 'Scene', scene.steps.map((step) => ({ name: step.name, at: step.at_s, lines: step.lines })), scene.duration, scene.cues.length)
    const step = Math.max(0, scene.steps.length ? scene.stepIndex : 0)
    const t = scene.t
    view = {
      scene: shownId,
      name: scene.sceneName ?? 'Scene',
      steps,
      live: true,
      canPlay: true,
      paused: scene.paused,
      pausedBy: scene.pausedBy,
      step,
      progress: steps[step]?.dur ? Math.max(0, Math.min(1, (t - steps[step].at) / steps[step].dur)) : 1,
      lines: scene.cues.map((cue) => cue.text)
    }
  } else if (shownId) {
    const record = stories?.stories.find((entry) => entry.scene === shownId)
    // The version the board shows (an undo can bring back an earlier one); the player can play only the newest.
    const story = record ? (versionOnBoard(record, lookOf(boardNodes())) ?? record.story) : null
    const known = record && story
      ? { name: record.name ?? 'Scene', steps: story.steps, lines: story.lines, duration: story.duration, newest: story === record.story }
      : lastLive.current?.scene === shownId
        ? { ...lastLive.current, newest: true }
        : null
    if (known) {
      const steps = panelSteps(known.name, known.steps, known.duration, known.lines.length)
      view = { scene: shownId, name: known.name, steps, live: false, canPlay: known.newest && scene.canReplay(shownId), paused: false, pausedBy: null, step: steps.length - 1, progress: 1, lines: known.lines.map((line) => line.text) }
    }
  }
  const { value, shown } = usePresence(view, fadeMs())

  // ---- position ----
  const panel = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<Position | null>(() => readPosition())
  const [box, setBox] = useState<{ left: number; top: number; room: number } | null>(null)
  const mounted = value !== null

  const layout = useCallback((wanted: Position | null) => {
    const element = panel.current
    const canvas = element?.parentElement
    if (!element || !canvas) return
    setBox(placeOf(canvas, element.offsetWidth, wanted))
  }, [])

  useLayoutEffect(() => {
    if (!mounted) return
    layout(position)
    const canvas = panel.current?.parentElement
    if (!canvas) return
    const observer = new ResizeObserver(() => layout(position))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [mounted, position, layout])

  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') || !box) return
    drag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top, id: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const toPosition = (event: React.PointerEvent<HTMLElement>): Position | null => {
    const element = panel.current
    const canvas = element?.parentElement
    if (!drag.current || !element || !canvas) return null
    const left = event.clientX - drag.current.dx
    const top = event.clientY - drag.current.dy
    const W = canvas.clientWidth
    const width = element.offsetWidth
    return left + width / 2 > W / 2 ? { side: 'right', x: W - width - left, y: top } : { side: 'left', x: left, y: top }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const next = toPosition(event)
    if (next) layout(next)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    const next = toPosition(event)
    drag.current = null
    if (!next || !box) return
    // Keep where it shows (clamped), measured from the nearer side.
    const element = panel.current
    const canvas = element?.parentElement
    if (!element || !canvas) return
    const W = canvas.clientWidth
    const width = element.offsetWidth
    const kept: Position = next.side === 'right' ? { side: 'right', x: W - width - box.left, y: box.top } : { side: 'left', x: box.left, y: box.top }
    setPosition(kept)
    writePosition(kept)
  }

  // ---- into the scene pill and out of it ----
  /** The panel is shrunk toward the pill (origin: the pill's centre in the panel); start: it shows so at once (an open from the pill begins there). */
  const [intoPill, setIntoPill] = useState<{ origin: string; start: boolean } | null>(null)
  const pillOrigin = (): string | null => {
    const element = panel.current
    const pill = document.querySelector('.scene-pill .pill')
    if (!element || !pill) return null
    const a = element.getBoundingClientRect()
    const b = pill.getBoundingClientRect()
    return `${Math.round(b.left + b.width / 2 - a.left)}px ${Math.round(b.top + b.height / 2 - a.top)}px`
  }
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hide = (): void => {
    const origin = pillOrigin()
    if (!origin) return hidePanel()
    setIntoPill({ origin, start: false })
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      hidePanel()
    }, tokenMs('--into-pill'))
  }
  // A hide on the way stops when the panel shows something else or opens again, and when it unmounts.
  useEffect(
    () => () => {
      if (!hideTimer.current) return
      clearTimeout(hideTimer.current)
      hideTimer.current = null
      setIntoPill(null)
    },
    [shownId, reading.fromPill]
  )
  // It stays shrunk until it unmounts.
  useEffect(() => {
    if (!mounted) setIntoPill(null)
  }, [mounted])
  // Opening from the pill: it starts shrunk at the pill and grows to its place.
  const growing = reading.fromPill && mounted
  useLayoutEffect(() => {
    if (!growing || !box) return
    const origin = pillOrigin()
    if (!origin) return openedFromPill()
    setIntoPill({ origin, start: true })
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setIntoPill(null)
        openedFromPill()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [growing, box !== null])

  if (!value) return null
  const replayable = value.canPlay
  const playStep = (index: number): void => {
    if (value.live) scene.playFrom(value.scene, index + 1)
    else if (replayable) scene.replay([{ scene: value.scene, step: index + 1 }])
  }
  const status = !value.live ? (value.canPlay ? 'Done' : 'Done · cannot replay') : value.paused ? (PAUSE_WORDS[value.pausedBy ?? ''] ?? 'Paused') : scene.steps.length ? `Step ${value.step + 1} of ${value.steps.length}` : ''
  const style = {
    ...(box ? { left: box.left, top: box.top, maxHeight: box.room } : { visibility: 'hidden' as const }),
    ...(intoPill ? { transformOrigin: intoPill.origin } : {})
  }
  return (
    <section
      ref={panel}
      className={`script-panel${shown ? ' is-shown' : ''}${intoPill ? ` is-into-pill${intoPill.start ? ' is-at-pill' : ''}` : ''}${value.live && !value.paused ? ' is-playing' : ''}`}
      style={style}
      aria-label="Scene"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <header className="script-panel__header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <span className={`status-dot status-dot--small${value.live && !value.paused ? ' status-dot--play' : ''}`} />
        <span className="script-panel__title" title={sentence(value.name)}>
          {sentence(value.name)}
        </span>
        <button className="icon-button icon-button--strong script-panel__hide" title="Hide" aria-label="Hide" onClick={hide}>
          <Minus size={14} strokeWidth={1.75} />
        </button>
      </header>
      <div className="script-panel__bar">
        {value.steps.map((step, i) => {
          const fill = value.live ? (i < value.step ? 1 : i === value.step ? value.progress : 0) : 1
          return (
            <button
              key={i}
              className="script-panel__segment"
              style={{ flexGrow: Math.max(step.dur, 0.01) }}
              title={sentence(step.name)}
              aria-label={`Play from step ${i + 1}: ${step.name}`}
              disabled={!value.live && !replayable}
              onClick={() => playStep(i)}
            >
              <span className="script-panel__track">
                <span className="script-panel__fill" style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
              </span>
            </button>
          )
        })}
      </div>
      <ReadingView scene={value.scene} lines={value.lines} steps={value.steps} live={value.live} moving={value.live && !value.paused} t={scene.t} time={scene.time} />
      <footer className="script-panel__footer">
        <span className="script-panel__status">{status}</span>
        {value.live ? (
          <>
            <button className="icon-button" title="Replay step" aria-label="Replay step" onClick={() => scene.playFrom(value.scene, value.step + 1)}>
              <RotateCcw size={14} strokeWidth={1.75} />
            </button>
            <button className="icon-button icon-button--strong" title={value.paused ? 'Play' : 'Pause'} aria-label={value.paused ? 'Play' : 'Pause'} onClick={() => (value.paused ? scene.resume() : scene.pause())}>
              {value.paused ? <Play size={13} strokeWidth={2} fill="currentColor" /> : <Pause size={13} strokeWidth={2} fill="currentColor" />}
            </button>
            <button className="icon-button" title="Next step" aria-label="Next step" onClick={() => scene.nextStep()}>
              <SkipForward size={14} strokeWidth={1.75} />
            </button>
          </>
        ) : (
          replayable && (
            <button className="icon-button" title="Replay" aria-label="Replay" onClick={() => scene.replay([{ scene: value.scene }])}>
              <RotateCcw size={14} strokeWidth={1.75} />
            </button>
          )
        )}
      </footer>
    </section>
  )
}

// ---------- The reading view ----------

/** Where the view's lines are, measured from its text (px). */
interface ReadingLayout {
  tops: number[]
  bottoms: number[]
  /** The text's height and the view's. */
  height: number
  view: number
  /** One visual line (font size × leading). */
  line: number
}

/**
 * The reading point (px from the text's top), continuous by construction: P_k is the middle of the
 * first visual line of step k (a step without lines: P_k = P_k+1, so it holds). During step k the point moves at
 * an even pace from P_k to P_k+1 over the step's play time, so it arrives just as step k+1 starts;
 * the last step goes from its P to the middle of the scene's last line. Before the first step: P_0.
 * Ended (not live): the middle of the last line. The light that centres on it lights one line.
 */
function readingPoint(layout: ReadingLayout, steps: readonly PanelStep[], live: boolean, t: number): number {
  const n = layout.tops.length
  if (!n) return 0
  const half = layout.line / 2
  const first = layout.tops[0] + half
  const last = Math.max(first, layout.bottoms[n - 1] - half)
  if (!live || !steps.length) return live ? first : last
  // A step without lines starts where the next spoken step starts (from the end back), so the step
  // before it still moves on and the silent step holds.
  const starts: number[] = new Array(steps.length)
  let after = last
  for (let i = steps.length - 1; i >= 0; i--) {
    const own = steps[i].lines.filter((index) => index >= 0 && index < n)
    after = own.length ? layout.tops[Math.min(...own)] + half : after
    starts[i] = after
  }
  let point = starts[0]
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.at > t + 1e-6) break
    const from = starts[i]
    const to = i + 1 < steps.length ? starts[i + 1] : last
    const share = step.dur > 0 ? Math.max(0, Math.min(1, (t - step.at) / step.dur)) : 1
    point = from + (to - from) * share
  }
  return point
}

function cssNumber(element: Element, name: string): number {
  const value = parseFloat(getComputedStyle(element).getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

/**
 * The scene's lines as a slow teleprompter (mockup v5, 2026-10-29). The text scrolls so that the
 * reading point stays in the middle of the view (at the start it stays at the top, at the end at
 * the bottom); the shown scroll follows its target with an exponential ease (--reading-ease), so a
 * new step's pace or a jump from the step bar is smooth. A mask on the view lights the reading
 * point and dims the lines said (--reading-said) and the lines next (--reading-next). The frame
 * loop runs only while the panel shows and the point or the scroll moves; it reads the player's
 * exact time, so a pause stops it and a seek moves it.
 */
function ReadingView({ scene, lines, steps, live, moving, t, time }: { scene: string; lines: string[]; steps: PanelStep[]; live: boolean; moving: boolean; t: number; time: () => number | null }) {
  const viewRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const layout = useRef<ReadingLayout | null>(null)
  const input = useRef({ steps, live, moving, t, time })
  input.current = { steps, live, moving, t, time }
  const motion = useRef({ shown: 0, frame: 0, last: 0, snap: true })

  const measure = useCallback((): void => {
    const view = viewRef.current
    const text = textRef.current
    if (!view || !text) return
    const paras = [...text.children] as HTMLElement[]
    const style = getComputedStyle(paras[0] ?? text)
    layout.current = {
      tops: paras.map((para) => para.offsetTop),
      bottoms: paras.map((para) => para.offsetTop + para.offsetHeight),
      height: text.offsetHeight,
      view: view.clientHeight,
      line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6 || 0
    }
  }, [])

  const tick = useCallback((now: number): void => {
    const m = motion.current
    m.frame = 0
    const at = layout.current
    const view = viewRef.current
    const text = textRef.current
    if (!at || !view || !text) return
    const { steps, live, moving, t, time } = input.current
    const point = readingPoint(at, steps, live, live ? (time() ?? t) : 0)
    const target = Math.max(0, Math.min(point - at.view / 2, Math.max(at.height - at.view, 0)))
    const dt = m.last ? now - m.last : 0
    m.last = now
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (m.snap || reduced) {
      m.shown = target
      m.snap = false
    } else {
      const tau = cssNumber(document.documentElement, '--reading-ease') || 120
      m.shown = target + (m.shown - target) * Math.exp(-dt / tau)
      if (Math.abs(m.shown - target) < 0.25) m.shown = target
    }
    text.style.transform = `translateY(${-m.shown}px)`
    view.style.setProperty('--reading-at', `${point - m.shown}px`)
    if (moving || m.shown !== target) m.frame = requestAnimationFrame(tick)
    else m.last = 0
  }, [])

  const kick = useCallback((): void => {
    const m = motion.current
    if (m.frame) return
    m.last = 0
    m.frame = requestAnimationFrame(tick)
  }, [tick])

  // Another scene (or its lines) shows: measure and stand at its reading point at once, before paint.
  // The lines' text is the key (the array is new on each state from the player).
  const linesKey = lines.join('\u0000')
  useLayoutEffect(() => {
    measure()
    const m = motion.current
    m.snap = true
    if (m.frame) cancelAnimationFrame(m.frame)
    tick(performance.now())
  }, [scene, linesKey, measure, tick])

  // Every new state from the player (time, step, pause): the loop runs again when it stopped.
  useEffect(() => kick())

  // A new width or font wraps the lines again.
  useEffect(() => {
    const view = viewRef.current
    const text = textRef.current
    if (!view || !text) return
    const observer = new ResizeObserver(() => {
      measure()
      kick()
    })
    observer.observe(view)
    observer.observe(text)
    return () => observer.disconnect()
  }, [measure, kick])

  useEffect(
    () => () => {
      const m = motion.current
      if (m.frame) cancelAnimationFrame(m.frame)
      m.frame = 0
    },
    []
  )

  return (
    <div className="script-panel__view" ref={viewRef}>
      <div className="script-panel__text" ref={textRef}>
        {lines.map((line, i) => (
          <p key={i} className="script-panel__para">
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}
