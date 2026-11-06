import { tip } from './Tooltip'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useSceneState } from '../live/state'
import { scenesNewestFirst, storyOfSelection, useBoardStories } from '../live/stories'
import { chooseScene, useReading } from '../live/reading'
import { useMenuDismiss } from '../lib/dismiss'
import { fadeMs, tokenMs, usePresence } from '../lib/presence'

/** Scene time as m:ss. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

interface PillView {
  playing: boolean
  /** It speaks of the selected item (text in --text-primary); key: that item's scene and step, for the one flash when it changes. */
  selected: string | null
  label: string
  count: string | null
  time: string | null
  /** The pill's one action while a scene plays or is paused: pause or resume. */
  action: { label: string; pause: boolean; run(): void } | null
}

/**
 * The top-bar scene pill, built from the agent pill's parts (decision B19, mockup v5). While a scene
 * plays: the accent dot, "<step> · i/n", the time and pause / resume. Otherwise: no button. With an
 * item selected that a scene drew, the pill wakes up: "Step 3 · <that step's first line>" in the
 * primary text colour, and it lights once when the selected step changes. Else, in grey: the
 * board's last scene from its records (also after a restart). A click on its label opens the shared
 * menu with every scene of the board, newest first; choosing one opens it in the reading panel.
 */
export function ScenePill() {
  const scene = useSceneState()
  const stories = useBoardStories()
  const reading = useReading()
  const scenes = scenesNewestFirst(stories)

  let view: PillView | null = null
  if (scene.playing || scene.paused) {
    view = {
      playing: !scene.paused,
      selected: null,
      label: sentence(scene.stepName ?? scene.sceneName ?? 'Scene'),
      count: scene.stepCount > 0 && scene.stepIndex >= 0 ? `${scene.stepIndex + 1}/${scene.stepCount}` : null,
      time: clock(scene.t),
      action: scene.paused ? { label: 'Resume scene', pause: false, run: () => scene.resume() } : { label: 'Pause scene', pause: true, run: () => scene.pause() }
    }
  } else {
    // A selected item that a scene drew (else changed): that scene's step, of the version that drew it (a dropped
    // scene too: an undo can bring its items back). The reading panel goes to the same step (storyOfSelection).
    const made = storyOfSelection(stories?.id ?? undefined, reading.selection)
    if (made) {
      const index = made.step
      const step = index !== null ? made.story.steps[index] : undefined
      const said = step?.lines.map((line) => made.story.lines[line]?.text).find((text) => !!text)
      view = {
        playing: false,
        selected: `${made.scene.scene}:${index ?? '-'}`,
        label: step && index !== null ? `Step ${index + 1} · ${said ?? sentence(step.name)}` : sentence(made.scene.name ?? 'Scene'),
        count: null,
        time: null,
        action: null
      }
    } else if (scenes[0]) {
      view = { playing: false, selected: null, label: sentence(scenes[0].name ?? 'Scene'), count: null, time: null, action: null }
    }
  }
  const { value, shown } = usePresence(view, fadeMs())

  // The menu: the shared menu below the pill; Escape and a click outside close it.
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useMenuDismiss(open, rootRef, useCallback(() => setOpen(false), []))
  useEffect(() => {
    if (!value) setOpen(false)
  }, [value])

  // The pill lights up once when the panel went into it, and when it wakes up for another selected step.
  // Each check compares with the value it saw last, so a re-render or StrictMode's second effect run never lights it.
  const [flash, setFlash] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const light = (): void => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setFlash(true)
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null
      setFlash(false)
    }, tokenMs('--pill-flash'))
  }
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    []
  )
  const flashes = useRef(reading.flash)
  useEffect(() => {
    if (reading.flash === flashes.current) return
    flashes.current = reading.flash
    light()
  }, [reading.flash])
  const selectedStep = view?.selected ?? null
  const lastSelected = useRef<string | null>(null)
  useEffect(() => {
    if (selectedStep === lastSelected.current) return
    lastSelected.current = selectedStep
    if (selectedStep) light()
  }, [selectedStep])

  if (!value) return null
  return (
    <div className={`scene-pill${shown ? ' is-shown' : ''}`} ref={rootRef}>
      <div className={`pill pill--static${value.selected ? ' pill--selected' : ''}${open ? ' pill--open' : ''}${flash ? ' pill--flash' : ''}`} data-state={value.playing ? 'playing' : 'idle'}>
        <button className="pill__toggle" aria-label="Scenes of this board" aria-expanded={open} disabled={!shown} onClick={() => setOpen((now) => !now)}>
          <span className={value.playing ? 'status-dot status-dot--play' : 'status-dot'} />
          <span className="pill__label">
            {value.label}
          </span>
          {value.count && (
            <span className="pill__count">
              <span className="pill__sep">· </span>
              {value.count}
            </span>
          )}
          {value.time && <span className="pill__time">{value.time}</span>}
        </button>
        {value.action && (
          <button className="pill__action" {...tip(value.action.label)} aria-label={value.action.label} disabled={!shown} onClick={value.action.run}>
            {value.action.pause ? <Pause size={12} strokeWidth={2} fill="currentColor" /> : <Play size={12} strokeWidth={2} fill="currentColor" />}
          </button>
        )}
      </div>
      {open && (
        <div className="menu scene-pop" role="menu" aria-label="Scenes">
          <div className="menu__heading">Scenes</div>
          {scenes.length === 0 && <div className="menu__row menu__meta">No scenes on this board yet</div>}
          {scenes.map((entry) => {
            const current = reading.panelScene === entry.scene
            const name = sentence(entry.name ?? 'Scene')
            return (
              <button
                key={entry.scene}
                className={`menu__item${current ? ' menu__item--current' : ''}`}
                role="menuitemradio"
                aria-checked={current}
                onClick={() => {
                  setOpen(false)
                  chooseScene(entry.scene)
                }}
              >
                <span className="menu__label">{name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


