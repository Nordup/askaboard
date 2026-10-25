import { Pause, Play } from 'lucide-react'
import { useSceneState } from '../live/state'
import { fadeMs, usePresence } from '../lib/presence'

/** Scene time as m:ss. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

interface PillView {
  paused: boolean
  label: string
  count: string | null
  time: string
}

/**
 * The top-bar playback pill, a sibling of the agent pill. It shows while a
 * scene plays or is paused: status dot, "<step> · i/n", the time, and one
 * pause / resume button.
 */
export function ScenePill() {
  const scene = useSceneState()
  const view: PillView | null =
    scene.playing || scene.paused
      ? {
          paused: scene.paused,
          label: scene.stepName ?? scene.sceneName ?? 'Scene',
          count: scene.stepCount > 0 && scene.stepIndex >= 0 ? `${scene.stepIndex + 1}/${scene.stepCount}` : null,
          time: clock(scene.t)
        }
      : null
  const { value, shown } = usePresence(view, fadeMs())
  if (!value) return null

  const action = value.paused ? 'Resume scene' : 'Pause scene'
  return (
    <div className={`pill pill--static scene-pill${shown ? ' is-shown' : ''}`} data-state={value.paused ? 'paused' : 'playing'}>
      <span className={value.paused ? 'status-dot' : 'status-dot status-dot--play'} />
      <span className="pill__label" title={value.label}>
        {value.label}
      </span>
      {value.count && (
        <span className="pill__count">
          <span className="pill__sep">· </span>
          {value.count}
        </span>
      )}
      <span className="pill__time">{value.time}</span>
      <button className="pill__action" title={action} aria-label={action} disabled={!shown} onClick={() => (value.paused ? scene.resume() : scene.pause())}>
        {value.paused ? <Play size={12} strokeWidth={2} fill="currentColor" /> : <Pause size={12} strokeWidth={2} fill="currentColor" />}
      </button>
    </div>
  )
}
