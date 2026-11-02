import type { SceneCue, SceneVoice } from '@shared/live-scene'
import { assetUrl } from '../board/content'

/**
 * The voice of say() lines (docs/learning-space/voice-lines-plan.md). The
 * player clock is the one clock: each frame the player gives the exact scene
 * time, and the one audio element is set from that alone. So pause, next,
 * replay, seek, a hold and a cut need no code here: they all arrive as a time,
 * and a cut line is only a shorter dur.
 *
 * The frames come from the player's requestAnimationFrame loop. A hidden or
 * minimized window gets no frames while the clock runs on: the element then
 * plays on by itself to the end of its line, where one timer stops it (each
 * call arms it again, and Chrome does not throttle timers on a page that plays
 * audio). The first frame after the window shows sets it right again.
 *
 * View > Read Lines Aloud off (main sends it): silence, also for scenes that
 * have a voice. Until main answers at start, the voice is off.
 */

/** The element goes to the clock only when it is further off than this: a smaller seek is heard as a click, a smaller gap is not heard. */
const DRIFT_S = 0.2
/** Playing at the very end of the clip would start it again from 0. */
const END_S = 0.03

let audio: HTMLAudioElement | null = null
/** The clip in the element. */
let loaded: string | null = null
/** Stops the element at the end of its line when frames stop. */
let lineEnd: ReturnType<typeof setTimeout> | undefined
let readLines = false

const stopListening = window.space?.onReadLines?.((on) => {
  readLines = on
  if (!on) stopVoice()
})
void window.space?.getReadLines?.().then((on) => (readLines = on))

/** One element for the window, made by the first voiced line. A scene with no voice makes none. */
function element(): HTMLAudioElement {
  if (audio) return audio
  const made = new Audio()
  made.preload = 'auto'
  window.addEventListener('pagehide', stopVoice)
  return (audio = made)
}

function load(media: HTMLAudioElement, clip: string): void {
  if (clip === loaded) return
  loaded = clip
  media.src = assetUrl(clip) ?? ''
}

/** Go to where the clock is, unless the element is on its way there. */
function place(media: HTMLAudioElement, at: number): void {
  if (!media.seeking && Math.abs(media.currentTime - at) > DRIFT_S) media.currentTime = at
}

/** A voiced line that runs at time t of its scene. */
export function voicedLineAt(cues: readonly SceneCue[], t: number): (SceneCue & { voice: SceneVoice }) | null {
  let line: SceneCue | null = null
  for (const cue of cues) if (cue.voice && t >= cue.at && t < cue.at + cue.dur) line = cue
  return line as (SceneCue & { voice: SceneVoice }) | null
}

/** The voice at this moment of a scene. advancing: its clock moves. */
export function followVoice(cues: readonly SceneCue[], t: number, advancing: boolean): void {
  clearTimeout(lineEnd)
  if (!readLines) {
    stopVoice()
    return
  }
  const line = voicedLineAt(cues, t)
  if (!line) {
    let next: SceneCue | null = null
    for (const cue of cues) if (cue.voice && cue.at > t && (!next || cue.at < next.at)) next = cue
    stopVoice()
    // The next line is ready when the clock reaches it, so it starts with no gap.
    if (next?.voice) {
      const media = element()
      load(media, next.voice.clip)
      place(media, next.voice.from)
    }
    return
  }
  const media = element()
  load(media, line.voice.clip)
  const at = line.voice.from + (t - line.at)
  // A clip that failed to load is silence. A line never fails a scene.
  if (media.error || !advancing || at >= media.duration - END_S) {
    media.pause()
    return
  }
  place(media, at)
  if (media.paused) void media.play().catch(() => undefined)
  lineEnd = setTimeout(stopVoice, (line.at + line.dur - t) * 1000)
}

/** No voice now: a line ended, or no scene shows. */
export function stopVoice(): void {
  clearTimeout(lineEnd)
  audio?.pause()
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopVoice()
    stopListening?.()
  })
