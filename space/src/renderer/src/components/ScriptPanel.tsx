import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Minus, Pause, Play, Plus, RotateCcw, SkipForward } from 'lucide-react'
import { useSceneScript, useSceneState, type SceneCueEntry, type SceneScript } from '../live/state'
import { fadeMs, usePresence } from '../lib/presence'

/*
 * The script panel: the lines (say) and steps of the scenes that play as one
 * explanation, in a small frame that floats over the board. The learner
 * drags it by its header and it stays there. While a scene plays, the words
 * read so far are bright and the rest is muted; steps not reached yet are
 * faint and their lines stay hidden. At the end every line is readable, and
 * a step title replays the script from that step.
 *
 * The one exception to "UI does not cover the board" (design-system.md).
 */

// ---------- Collapsed or open (shared with the scene pill) ----------

let collapsed = false
const viewListeners = new Set<() => void>()

function setCollapsed(next: boolean): void {
  if (next === collapsed) return
  collapsed = next
  for (const listener of viewListeners) listener()
}

function subscribeView(listener: () => void): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

/** The scene pill: open a collapsed panel, collapse an open one. */
export function toggleScriptPanel(): void {
  setCollapsed(!collapsed)
}

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

// ---------- The script as steps ----------

interface Group {
  key: string
  title: string
  /** The committed scene and the step it replays from (none: from the scene's start). */
  scene: string
  step?: string
  sceneIndex: number
  at: number
  cues: SceneCueEntry[]
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Each scene's steps with their lines; lines before a scene's first step (or a scene with no steps) go under the scene's name. */
function groupsOf(script: SceneScript): Group[] {
  const groups: Group[] = []
  script.scenes.forEach((scene, sceneIndex) => {
    const steps = [...scene.steps].sort((a, b) => a.at_s - b.at_s)
    const first = steps.length ? steps[0].at_s : Infinity
    const before = scene.cues.filter((cue) => cue.at_s < first - 1e-6)
    if (before.length) groups.push({ key: `${scene.of}:`, title: sentence(scene.name ?? 'Scene'), scene: scene.of, sceneIndex, at: 0, cues: before })
    steps.forEach((step, i) => {
      const end = steps[i + 1]?.at_s ?? Infinity
      groups.push({
        key: `${scene.of}:${i}`,
        title: sentence(step.name),
        scene: scene.of,
        step: step.name,
        sceneIndex,
        at: step.at_s,
        cues: scene.cues.filter((cue) => cue.at_s >= step.at_s - 1e-6 && cue.at_s < end - 1e-6)
      })
    })
  })
  return groups
}

// ---------- The panel ----------

export function ScriptPanel() {
  const script = useSceneScript()
  const scene = useSceneState()
  const isCollapsed = useSyncExternalStore(subscribeView, () => collapsed)
  const groups = useMemo(() => (script ? groupsOf(script) : []), [script])
  const { value, shown } = usePresence(script && groups.length ? { script, groups } : null, fadeMs())

  // A new script opens the panel.
  const scriptId = script?.id ?? null
  useEffect(() => {
    if (scriptId !== null) setCollapsed(false)
  }, [scriptId])

  // ---- position ----
  const panel = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<Position | null>(() => readPosition())
  const [box, setBox] = useState<{ left: number; top: number; room: number } | null>(null)
  const mounted = value !== null

  const layout = useCallback((wanted: Position | null) => {
    const element = panel.current
    const canvas = element?.parentElement
    if (!element || !canvas) return
    const margin = cssPx(element, '--space-3')
    const header = cssPx(element, '--script-panel-header')
    const width = element.offsetWidth
    const W = canvas.clientWidth
    const H = canvas.clientHeight
    // Never over the tool palette: the panel ends a margin above it.
    const palette = canvas.querySelector<HTMLElement>('.palette')
    const floor = palette ? palette.offsetTop - margin : H - margin
    const at = wanted ?? { side: 'right', x: margin, y: margin }
    const rawLeft = at.side === 'left' ? at.x : W - width - at.x
    const left = Math.round(Math.max(margin, Math.min(W - width - margin, rawLeft)))
    const top = Math.round(Math.max(margin, Math.min(floor - header - 2, at.y)))
    setBox({ left, top, room: Math.max(header + 2, floor - top) })
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

  // ---- where the script is now ----
  const live = value && !value.script.finished && value.script.current >= 0 && scene.playing
  const t = scene.t
  const currentGroup = useMemo(() => {
    if (!value || !live) return -1
    let index = -1
    value.groups.forEach((group, i) => {
      if (group.sceneIndex < value.script.current || (group.sceneIndex === value.script.current && group.at <= t + 1e-6)) index = i
    })
    return index
  }, [value, live, t])

  // ---- keep the current line in view (unless the learner scrolled away) ----
  const body = useRef<HTMLDivElement>(null)
  const currentLine = useRef<HTMLParagraphElement | null>(null)
  const currentTitle = useRef<HTMLParagraphElement | null>(null)
  /** What follows the reading: the current line, or the current step's title before its first line. */
  const anchor = (): HTMLElement | null => currentLine.current ?? currentTitle.current
  const follow = useRef(true)
  useEffect(() => {
    follow.current = true
  }, [scriptId])
  const lineKey = `${currentGroup}:${scene.currentCue?.at_s ?? ''}:${scene.currentCue?.readSoFar.length ?? ''}`
  useLayoutEffect(() => {
    const view = body.current
    const line = anchor()
    if (!live || !view || !line || !follow.current) return
    const pad = cssPx(view, '--space-3')
    const lineTop = line.offsetTop - view.offsetTop
    const lineBottom = lineTop + line.offsetHeight
    if (lineBottom + pad > view.scrollTop + view.clientHeight) view.scrollTop = lineBottom + pad - view.clientHeight
    else if (lineTop < view.scrollTop) view.scrollTop = Math.max(0, lineTop - pad)
  }, [lineKey, live, isCollapsed])
  const onScroll = (): void => {
    const view = body.current
    const line = anchor()
    if (!view || !line) return
    const lineTop = line.offsetTop - view.offsetTop
    follow.current = lineTop + line.offsetHeight > view.scrollTop && lineTop < view.scrollTop + view.clientHeight
  }

  if (!value) return null
  const { script: shownScript, groups: shownGroups } = value
  const finished = !live
  const paused = live && scene.paused
  const title = sentence(shownScript.scenes[0]?.name ?? 'Scene')
  const count = finished ? `${shownGroups.length}/${shownGroups.length}` : `${Math.max(1, currentGroup + 1)}/${shownGroups.length}`

  const replayFrom = (index: number): void => {
    const group = shownGroups[index]
    if (!group) return
    const scenes = shownScript.scenes.slice(group.sceneIndex)
    follow.current = true
    scene.replay(scenes.map((entry, i) => ({ scene: entry.of, ...(i === 0 && group.step ? { step: group.step } : {}) })))
  }

  // The line that shows as "current": the one being read, or else the last line read in the current step.
  const cue = scene.currentCue
  let currentCueAt: number | null = null
  if (live && currentGroup >= 0) {
    const group = shownGroups[currentGroup]
    if (cue && group.cues.some((entry) => entry.at_s === cue.at_s)) currentCueAt = cue.at_s
    else {
      const read = group.cues.filter((entry) => entry.at_s + entry.dur_s <= t + 1e-6)
      currentCueAt = read.length ? read[read.length - 1].at_s : null
    }
  }

  const style = box ? { left: box.left, top: box.top, maxHeight: box.room } : { visibility: 'hidden' as const }
  return (
    <section
      ref={panel}
      className={`script-panel${shown ? ' is-shown' : ''}${isCollapsed ? ' is-collapsed' : ''}`}
      style={style}
      aria-label="Script"
    >
      <header className="script-panel__header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <span className={`status-dot status-dot--small${live && !paused ? ' status-dot--play' : ''}`} />
        <span className="script-panel__title" title={title}>
          {title}
        </span>
        <span className="script-panel__count">{count}</span>
        <span className="script-panel__actions">
          <button className="icon-button icon-button--strong" title="Restart" aria-label="Restart" onClick={() => replayFrom(0)}>
            <RotateCcw size={14} strokeWidth={1.75} />
          </button>
          {live && (
            <button className="icon-button icon-button--strong" title={paused ? 'Play' : 'Pause'} aria-label={paused ? 'Play' : 'Pause'} onClick={() => (paused ? scene.resume() : scene.pause())}>
              {paused ? <Play size={13} strokeWidth={2} fill="currentColor" /> : <Pause size={13} strokeWidth={2} fill="currentColor" />}
            </button>
          )}
          {live && (
            <button className="icon-button icon-button--strong" title="Next step" aria-label="Next step" onClick={() => scene.nextStep()}>
              <SkipForward size={14} strokeWidth={1.75} />
            </button>
          )}
          <button
            className="icon-button icon-button--strong"
            title={isCollapsed ? 'Expand' : 'Collapse'}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed(!isCollapsed)}
          >
            {isCollapsed ? <Plus size={14} strokeWidth={1.75} /> : <Minus size={14} strokeWidth={1.75} />}
          </button>
        </span>
      </header>
      {!isCollapsed && (
        <div ref={body} className="script-panel__body" onScroll={onScroll}>
          {shownGroups.map((group, index) => {
            const state = finished ? 'final' : index < currentGroup ? 'done' : index === currentGroup ? 'current' : 'ahead'
            return (
              <div key={group.key} className={`script-step script-step--${state}`}>
                {finished ? (
                  <button className="script-step__title" title="Replay from here" onClick={() => replayFrom(index)}>
                    {index + 1} · {group.title}
                  </button>
                ) : (
                  <p ref={state === 'current' ? currentTitle : undefined} className="script-step__title">
                    {index + 1} · {group.title}
                  </p>
                )}
                {state !== 'ahead' &&
                  group.cues.map((entry) => {
                    if (state === 'current' && entry.at_s > t + 1e-6) return null
                    const isCurrent = state === 'current' && entry.at_s === currentCueAt
                    if (!isCurrent) {
                      return (
                        <p key={entry.at_s} className="script-line">
                          {entry.text}
                        </p>
                      )
                    }
                    const reading = cue && cue.at_s === entry.at_s && entry.text.startsWith(cue.readSoFar) ? cue.readSoFar : entry.text
                    return (
                      <p key={entry.at_s} ref={currentLine} className="script-line script-line--current">
                        {reading}
                        <span className="script-line__rest">{entry.text.slice(reading.length)}</span>
                      </p>
                    )
                  })}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
