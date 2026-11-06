import { tip } from './Tooltip'
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Minus, Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import { useSceneState } from '../live/state'
import { rebuildFailure, useRestoredVersion } from '../live/rebuild'
import { lookOf, storyOfSelection, useBoardStories, versionOnBoard } from '../live/stories'
import { boardNodes, hidePanel, openedFromPill, sceneStarted, setPanelScene, useReading } from '../live/reading'
import { fadeMs, tokenMs, usePresence } from '../lib/presence'
import { boardControlsTop } from './BoardControls'

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
  // Never over the board controls: the panel ends a margin above their bottom row.
  const controls = boardControlsTop(canvas)
  const floor = (controls ?? H) - margin
  const at = wanted ?? { side: 'right', x: margin, y: margin }
  const rawLeft = at.side === 'left' ? at.x : W - width - at.x
  const left = Math.round(Math.max(margin, Math.min(W - width - margin, rawLeft)))
  const top = Math.round(Math.max(margin, Math.min(floor - header - 2, at.y)))
  return { left, top, room: Math.max(header + 2, floor - top) }
}

/**
 * The window rect (client CSS px) that the panel takes when it shows, measured from the panel
 * element itself: it stays mounted and laid out at its place also while it shows nothing (hidden,
 * in the shape it has while a scene plays), so the rect is the real one before a scene, during it
 * and after it. Offsets, not getBoundingClientRect: the shrink into the pill is a transform.
 * Null when no board is open.
 */
export function scriptPanelArea(): { left: number; top: number; right: number; bottom: number } | null {
  const canvas = document.querySelector<HTMLElement>('.canvas')
  const element = canvas?.querySelector<HTMLElement>(':scope > .script-panel')
  if (!canvas || !element || !canvas.querySelector(':scope > .board')) return null
  const origin = canvas.getBoundingClientRect()
  const left = origin.left + canvas.clientLeft + element.offsetLeft
  const top = origin.top + canvas.clientTop + element.offsetTop
  return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight }
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
  /** Each line's own time on the scene's timeline (s): a click on a line plays from there. */
  lineAt: number[]
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

/** What the hidden panel holds while it shows nothing: a playing scene's shape (its header, bar, view and buttons), so its box is the one a scene gets. */
const IDLE_VIEW: PanelView = { scene: '', name: '', steps: [{ name: '', at: 0, dur: 1, lines: [] }], live: true, paused: false, pausedBy: null, canPlay: false, step: 0, progress: 0, lines: [], lineAt: [] }

// ---------- The panel ----------

export function ScriptPanel() {
  const scene = useSceneState()
  // A scene restored from the records after a restart replays by a re-run; the panel shows when one could not be rebuilt.
  useRestoredVersion()
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
  const lastLive = useRef<{ scene: string; name: string; steps: Array<{ name: string; at: number; lines: number[] }>; lines: Array<{ text: string; at: number }>; duration: number } | null>(null)
  if (liveId) lastLive.current = { scene: liveId, name: scene.sceneName ?? 'Scene', steps: scene.steps.map((step) => ({ name: step.name, at: step.at_s, lines: step.lines })), lines: scene.cues.map((cue) => ({ text: cue.text, at: cue.at_s })), duration: scene.duration }
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
      lines: scene.cues.map((cue) => cue.text),
      lineAt: scene.cues.map((cue) => cue.at_s)
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
      view = { scene: shownId, name: known.name, steps, live: false, canPlay: known.newest && scene.canReplay(shownId), paused: false, pausedBy: null, step: steps.length - 1, progress: 1, lines: known.lines.map((line) => line.text), lineAt: known.lines.map((line) => line.at) }
    }
  }
  const { value: presented, shown } = usePresence(view, fadeMs())

  // ---- position ----
  const panel = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<Position | null>(() => readPosition())
  const [box, setBox] = useState<{ left: number; top: number; room: number } | null>(null)
  const mounted = presented !== null

  const layout = useCallback((wanted: Position | null) => {
    const element = panel.current
    const canvas = element?.parentElement
    if (!element || !canvas) return
    setBox(placeOf(canvas, element.offsetWidth, wanted))
  }, [])

  // Laid out also while it shows nothing: its box is what scriptPanelArea measures.
  useLayoutEffect(() => {
    layout(position)
    const canvas = panel.current?.parentElement
    if (!canvas) return
    const observer = new ResizeObserver(() => layout(position))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [position, layout])

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

  const idle = presented === null
  const value = presented ?? IDLE_VIEW
  const replayable = value.canPlay
  const moving = !idle && value.live && !value.paused
  // The step bar, the step replay and a click on a line: the scene that shows plays from there (a replay, also after a restart).
  const playable = !idle && (value.live || replayable)
  const playStep = (index: number): void => {
    if (playable) scene.playFrom(value.scene, { step: index + 1 })
  }
  const playLine = (index: number): void => {
    if (playable) scene.playFrom(value.scene, { at: value.lineAt[index] ?? 0 })
  }

  // ---- the reading view's focus (mockup v7): the one owner of what the view's scroll and light stand on ----
  // The selected item's step, when the view shows its scene and the scene does not play (the pill's lookup).
  const picked = !value.live && value.scene ? storyOfSelection(stories?.id ?? undefined, reading.selection) : null
  const pick = picked && picked.scene.scene === value.scene && picked.step !== null ? firstLineOf(value.steps, picked.step, value.lines.length) : null
  const pickKey = pick !== null && picked ? `${value.scene}:${picked.step}` : null
  const [held, setHeld] = useState<Focus>(() => ({ scene: '', live: true, picked: null, mode: 'follow', line: 0, at: null, band: false }))
  let focus = held
  if (held.scene !== value.scene || held.live !== value.live) {
    // Another scene, or the scene starts or ends: Follow (or the selected step of a scene that does not play).
    focus = { scene: value.scene, live: value.live, picked: pickKey, mode: pick !== null ? 'select' : 'follow', line: pick ?? 0, at: null, band: false }
  } else if (pickKey !== held.picked) {
    // The selection changed: its step, else (a deselect) the focus stays where it shows.
    focus = pick !== null ? { ...held, picked: pickKey, mode: 'select', line: pick, at: null, band: false } : held.mode === 'select' ? { ...held, picked: null, mode: 'free', at: null, band: true } : { ...held, picked: null }
  }
  if (focus !== held) setHeld(focus)
  // While a scene plays, the focus glides back to the reading point a while after the last wheel input.
  useEffect(() => {
    if (focus.mode !== 'free' || !moving) return
    const timer = setTimeout(() => setHeld((now) => (now === focus ? { ...now, mode: 'follow', at: null, band: false } : now)), tokenMs('--reading-return'))
    return () => clearTimeout(timer)
  }, [focus, moving])

  const status = !value.live ? (value.canPlay ? 'Done' : rebuildFailure(value.scene) ? 'Done · could not be rebuilt' : 'Done · cannot replay') : value.paused ? (PAUSE_WORDS[value.pausedBy ?? ''] ?? 'Paused') : focus.mode === 'free' ? 'Scrolled · back in a moment' : scene.steps.length ? `Step ${value.step + 1} of ${value.steps.length}` : ''
  const style = {
    ...(box ? { left: box.left, top: box.top, maxHeight: box.room } : {}),
    ...(!box || idle ? { visibility: 'hidden' as const } : {}),
    ...(intoPill ? { transformOrigin: intoPill.origin } : {})
  }
  return (
    <section
      ref={panel}
      className={`script-panel${shown ? ' is-shown' : ''}${intoPill ? ` is-into-pill${intoPill.start ? ' is-at-pill' : ''}` : ''}${value.live && !value.paused ? ' is-playing' : ''}`}
      style={style}
      aria-label="Scene"
      aria-hidden={idle || undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <header className="script-panel__header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <span className={`status-dot status-dot--small${value.live && !value.paused ? ' status-dot--play' : ''}`} />
        <span className="script-panel__title">
          {sentence(value.name)}
        </span>
        <button className="icon-button icon-button--strong script-panel__hide" {...tip('Hide')} aria-label="Hide" onClick={hide}>
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
              {...tip(sentence(step.name))}
              aria-label={`Play from step ${i + 1}: ${step.name}`}
              disabled={!playable}
              onClick={() => playStep(i)}
            >
              <span className="script-panel__track">
                <span className="script-panel__fill" style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
              </span>
            </button>
          )
        })}
      </div>
      <ReadingView scene={value.scene} lines={value.lines} steps={value.steps} live={value.live} moving={moving} t={scene.t} time={scene.time} focus={focus} onFocus={setHeld} onLine={playable ? playLine : undefined} />
      <footer className="script-panel__footer">
        <span className="script-panel__status">{status}</span>
        {value.live ? (
          <>
            <button className="icon-button" {...tip('Replay step')} aria-label="Replay step" onClick={() => scene.playFrom(value.scene, { step: value.step + 1 })}>
              <RotateCcw size={14} strokeWidth={1.75} />
            </button>
            <button className="icon-button icon-button--strong" {...tip(value.paused ? 'Play' : 'Pause')} aria-label={value.paused ? 'Play' : 'Pause'} onClick={() => (value.paused ? scene.resume() : scene.pause())}>
              {value.paused ? <Play size={13} strokeWidth={2} fill="currentColor" /> : <Pause size={13} strokeWidth={2} fill="currentColor" />}
            </button>
            <button className="icon-button" {...tip('Next step')} aria-label="Next step" onClick={() => scene.nextStep()}>
              <SkipForward size={14} strokeWidth={1.75} />
            </button>
          </>
        ) : (
          replayable && (
            <button className="icon-button" {...tip('Replay')} aria-label="Replay" onClick={() => scene.replay([{ scene: value.scene }])}>
              <RotateCcw size={14} strokeWidth={1.75} />
            </button>
          )
        )}
      </footer>
    </section>
  )
}

// ---------- The reading view ----------

/**
 * The reading view's focus (mockup v7, 2026-10-29): the one point that the scroll and the light
 * stand on. ScriptPanel holds it (one state); the view eases its shown focus and scroll toward it.
 * - follow: the reading point (a scene plays; ended: the last line).
 * - free: the learner's wheel moved it (at, px from the text's top; null: the focus and the scroll stay where they show now). While
 *   a scene plays it returns to follow --reading-return after the last wheel input.
 * - select: the middle of the first line of the selected item's step (line); the scroll puts that
 *   line at the top of the bright band (--reading-band-offset above it).
 * scene and live: the view it belongs to (another scene, or a start or an end, starts it again);
 * picked: the selected step it saw last ("scene:step"), so only a change of the selection moves it.
 */
export interface Focus {
  scene: string
  live: boolean
  picked: string | null
  mode: 'follow' | 'free' | 'select'
  line: number
  at: number | null
  /** free: the scroll keeps the band's place of the select it came from (so a deselect moves nothing). */
  band: boolean
}

/** The first line of step index (a step without lines: of the next step with lines), or null. */
function firstLineOf(steps: readonly PanelStep[], index: number, lineCount: number): number | null {
  for (let i = index; i < steps.length; i++) {
    const own = steps[i].lines.filter((line) => line >= 0 && line < lineCount)
    if (own.length) return Math.min(...own)
  }
  return null
}

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

/** The range of a focus: the middle of the first visual line to the middle of the last one. */
function lineRange(layout: ReadingLayout): [number, number] {
  const n = layout.tops.length
  if (!n) return [0, 0]
  const half = layout.line / 2
  const first = layout.tops[0] + half
  return [first, Math.max(first, layout.bottoms[n - 1] - half)]
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
  const [first, last] = lineRange(layout)
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
 * The scene's lines as a slow teleprompter (mockups v5 and v7, 2026-10-29). One focus point
 * (Focus above) drives both the scroll and the light: the scroll keeps the focus in the middle of
 * the view (clamped, so at the start the text stays at the top and at the end at the bottom, and
 * the light moves on to the first or the last line), and a mask on the view lights the focus and
 * dims the lines above (--reading-said) and below (--reading-next). The shown focus and scroll
 * follow their targets with an exponential ease (--reading-ease), so every change is smooth. The
 * wheel moves the focus (free); a click on a line plays the scene from it (onLine). The frame loop
 * runs only while the panel shows and something moves; it reads the player's exact time, so a
 * pause stops it and a seek moves it.
 */
function ReadingView({ scene, lines, steps, live, moving, t, time, focus, onFocus, onLine }: { scene: string; lines: string[]; steps: PanelStep[]; live: boolean; moving: boolean; t: number; time: () => number | null; focus: Focus; onFocus: (next: Focus) => void; onLine?: (index: number) => void }) {
  const viewRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const layout = useRef<ReadingLayout | null>(null)
  const input = useRef({ steps, live, moving, t, time, focus, onFocus })
  input.current = { steps, live, moving, t, time, focus, onFocus }
  /** What shows now: the scroll (shown) and the focus, each easing toward its target. */
  const motion = useRef({ shown: 0, focus: 0, frame: 0, last: 0, snap: true })

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
    const { steps, live, moving, t, time, focus } = input.current
    const half = at.line / 2
    const [lo, hi] = lineRange(at)
    // The scroll puts the focus at this height in the view: the middle, or (a selected step) its line at the top of the bright band.
    const centre = at.view / 2
    const band = at.view / 2 - cssNumber(view, '--reading-light') - cssNumber(view, '--reading-band-offset') + half
    let aim: number
    let anchor = centre
    if (focus.mode === 'select') {
      aim = (at.tops[Math.min(focus.line, at.tops.length - 1)] ?? 0) + half
      anchor = band
    } else if (focus.mode === 'free') {
      aim = Math.max(lo, Math.min(hi, focus.at ?? m.focus))
      if (focus.band) anchor = band
    } else aim = readingPoint(at, steps, live, live ? (time() ?? t) : 0)
    // Free with no position yet (a deselect): the focus and the scroll stay as they show at this moment, also mid-ease.
    const held = focus.mode === 'free' && focus.at === null
    if (held) aim = m.focus
    const target = held ? m.shown : Math.max(0, Math.min(aim - anchor, Math.max(at.height - at.view, 0)))
    const dt = m.last ? now - m.last : 0
    m.last = now
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (m.snap || reduced) {
      m.shown = target
      m.focus = aim
      m.snap = false
    } else {
      const tau = cssNumber(document.documentElement, '--reading-ease') || 120
      const keep = Math.exp(-dt / tau)
      m.shown = target + (m.shown - target) * keep
      m.focus = aim + (m.focus - aim) * keep
      if (Math.abs(m.shown - target) < 0.25) m.shown = target
      if (Math.abs(m.focus - aim) < 0.25) m.focus = aim
    }
    text.style.transform = `translateY(${-m.shown}px)`
    view.style.setProperty('--reading-at', `${m.focus - m.shown}px`)
    if (moving || m.shown !== target || m.focus !== aim) m.frame = requestAnimationFrame(tick)
    else m.last = 0
  }, [])

  const kick = useCallback((): void => {
    const m = motion.current
    if (m.frame) return
    m.last = 0
    m.frame = requestAnimationFrame(tick)
  }, [tick])

  // Another scene (or its lines) shows: measure and stand at its focus at once, before paint.
  // The lines' text is the key (the array is new on each state from the player).
  const linesKey = lines.join('\u0000')
  useLayoutEffect(() => {
    measure()
    const m = motion.current
    m.snap = true
    if (m.frame) cancelAnimationFrame(m.frame)
    tick(performance.now())
  }, [scene, linesKey, measure, tick])

  // Every new state from the player (time, step, pause) and every new focus: the loop runs again when it stopped.
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

  // The wheel (or a trackpad) moves the focus, within the first and the last line (free). Not passive: the page never scrolls.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const at = layout.current
      const { focus, onFocus } = input.current
      if (!at || !at.tops.length || !focus.scene) return
      const dy = event.deltaY * (event.deltaMode === 1 ? at.line : event.deltaMode === 2 ? at.view : 1)
      if (!dy) return
      const [lo, hi] = lineRange(at)
      const from = focus.mode === 'free' && focus.at !== null ? focus.at : motion.current.focus
      onFocus({ ...focus, mode: 'free', at: Math.max(lo, Math.min(hi, from + dy)), band: focus.mode === 'select' || (focus.mode === 'free' && focus.band) })
    }
    view.addEventListener('wheel', wheel, { passive: false })
    return () => view.removeEventListener('wheel', wheel)
  }, [])

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
          <p key={i} className={`script-panel__para${onLine ? ' is-playable' : ''}`} onClick={onLine ? () => onLine(i) : undefined}>
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}
