import { useEffect, useRef, useState } from 'react'
import { Check, Pause, Play } from 'lucide-react'
import { useSceneState } from '../live/state'
import { lookOf, scenesNewestFirst, storiesOfNode, useBoardStories, versionOnBoard } from '../live/stories'
import { boardNodes, chooseScene, showFromPill, useReading } from '../live/reading'
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
  label: string
  count: string | null
  time: string | null
  /** The pill's one action: pause or play. Null when nothing can play (the player no longer holds the scene). */
  action: { label: string; pause: boolean; run(): void } | null
}

/**
 * The top-bar scene pill, built from the agent pill's parts (decision B19). While a scene plays:
 * the accent dot, "<step> · i/n", the time and pause / resume. Otherwise, in grey: the scene of a
 * selected item and its step (play replays that step), else the board's last scene from its records,
 * also after a restart (play replays it). A click on its label opens the shared menu with every
 * scene of the board, newest first; choosing one opens it in the reading panel.
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
      label: sentence(scene.stepName ?? scene.sceneName ?? 'Scene'),
      count: scene.stepCount > 0 && scene.stepIndex >= 0 ? `${scene.stepIndex + 1}/${scene.stepCount}` : null,
      time: clock(scene.t),
      action: scene.paused ? { label: 'Resume scene', pause: false, run: () => scene.resume() } : { label: 'Pause scene', pause: true, run: () => scene.pause() }
    }
  } else {
    // A selected item that a scene drew: that scene and step, of the version that drew it (a dropped scene too:
    // an undo can bring its items back). The player can replay only a scene's newest version.
    const made = reading.selection.map((id) => storiesOfNode(stories?.id ?? undefined, id).find((entry) => entry.made)).find((entry) => entry)
    const replay = (id: string, newest: boolean, step?: number): PillView['action'] =>
      newest && scene.canReplay(id)
        ? {
            label: step ? 'Replay this step' : 'Replay scene',
            pause: false,
            run: () => {
              showFromPill()
              scene.replay([{ scene: id, ...(step ? { step } : {}) }])
            }
          }
        : null
    if (made) {
      const step = made.step !== null ? made.story.steps[made.step] : null
      const name = sentence(made.scene.name ?? 'Scene')
      view = {
        playing: false,
        label: step ? `${name} · ${sentence(step.name)}` : name,
        count: step ? `${(made.step as number) + 1}/${made.story.steps.length}` : null,
        time: null,
        action: replay(made.scene.scene, made.story === made.scene.story, step ? (made.step as number) + 1 : undefined)
      }
    } else if (scenes[0]) {
      const last = scenes[0]
      const story = versionOnBoard(last, lookOf(boardNodes())) ?? last.story
      const n = story.steps.length
      view = { playing: false, label: sentence(last.name ?? 'Scene'), count: n ? `${n}/${n}` : null, time: null, action: replay(last.scene, story === last.story) }
    }
  }
  const { value, shown } = usePresence(view, fadeMs())

  // The menu: the shared menu below the pill; Escape and a click outside close it.
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  useEffect(() => {
    if (!value) setOpen(false)
  }, [value])

  // The pill lights up once when the panel went into it.
  const [flash, setFlash] = useState(false)
  const flashes = useRef(reading.flash)
  useEffect(() => {
    if (reading.flash === flashes.current) return
    flashes.current = reading.flash
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), tokenMs('--pill-flash'))
    return () => clearTimeout(timer)
  }, [reading.flash])

  if (!value) return null
  return (
    <div className={`scene-pill${shown ? ' is-shown' : ''}`} ref={rootRef}>
      <div className={`pill pill--static${open ? ' pill--open' : ''}${flash ? ' pill--flash' : ''}`} data-state={value.playing ? 'playing' : 'idle'}>
        <button className="pill__toggle" title="Scenes" aria-label="Scenes of this board" aria-expanded={open} disabled={!shown} onClick={() => setOpen((now) => !now)}>
          <span className={value.playing ? 'status-dot status-dot--play' : 'status-dot'} />
          <span className="pill__label" title={value.label}>
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
          <button className="pill__action" title={value.action.label} aria-label={value.action.label} disabled={!shown} onClick={value.action.run}>
            {value.action.pause ? <Pause size={12} strokeWidth={2} fill="currentColor" /> : <Play size={12} strokeWidth={2} fill="currentColor" />}
          </button>
        )}
      </div>
      {open && (
        <div className="menu scene-pop" role="menu" aria-label="Scenes">
          <div className="menu__heading">Scenes</div>
          {scenes.length === 0 && <div className="menu__row menu__meta">No scenes on this board yet</div>}
          {scenes.map((entry) => {
            const n = entry.story.steps.length
            return (
              <button
                key={entry.scene}
                className="menu__item"
                role="menuitemradio"
                aria-checked={reading.panelScene === entry.scene}
                onClick={() => {
                  setOpen(false)
                  chooseScene(entry.scene)
                }}
              >
                <span className="menu__icon">{reading.panelScene === entry.scene && <Check size={14} strokeWidth={2} />}</span>
                <span className="menu__label">{sentence(entry.name ?? 'Scene')}</span>
                <span className="menu__hint">{n === 1 ? '1 step' : `${n} steps`}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


