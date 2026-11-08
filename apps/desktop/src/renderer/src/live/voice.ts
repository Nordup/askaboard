import type { SceneCue, SceneVoice } from '@shared/live-scene'
import { assetUrl } from '../board/content'
import { subscribeSettings } from '../lib/settings'

/**
 * The voice of say() lines (decision T34). The
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
 * A line that runs straight into the next one of its clip is one sound: the
 * element plays on, with no pause, seek or stop between them. A real hold (the
 * next line starts later) pauses it at the line's end, in silence.
 *
 * View > Read Lines Aloud off (main sends it): silence, also for scenes that
 * have a voice. Until main answers at start, the voice is off.
 */

/** A playing element goes to the clock only when it is further off than this: a smaller seek is heard as a click, a smaller gap is not heard. */
const DRIFT_S = 0.2
/** A paused element goes to the exact place: a seek there is not heard, and a line starts in silence, so its first sound stays whole. */
const PAUSED_DRIFT_S = 0.02
/** Playing at the very end of the clip would start it again from 0. */
const END_S = 0.03
/** Two times this close are one moment: the times are rounded to the millisecond. */
const SAME_S = 0.005

let audio: HTMLAudioElement | null = null
/** The clip in the element. */
let loaded: string | null = null
/** Where the element was sent last. While it stays there it is still starting its audio: a new seek would start that again, and it would never play. */
let sent = -1
/** Stops the element at the end of its line when frames stop. */
let lineEnd: ReturnType<typeof setTimeout> | undefined
let readLines = false

// Settings > Voice > Read lines aloud (lib/settings.ts mirrors main's snapshot).
const stopListening = subscribeSettings((settings) => {
  readLines = settings.voice.readLines
  if (!readLines) stopVoice()
})

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
  if (media.seeking || (!media.paused && Math.abs(media.currentTime - sent) < 0.001)) return
  if (Math.abs(media.currentTime - at) > (media.paused ? PAUSED_DRIFT_S : DRIFT_S)) media.currentTime = sent = at
}

/** A voiced line that runs at time t of its scene. */
export function voicedLineAt(cues: readonly SceneCue[], t: number): (SceneCue & { voice: SceneVoice }) | null {
  let line: SceneCue | null = null
  for (const cue of cues) if (cue.voice && t >= cue.at && t < cue.at + cue.dur) line = cue
  return line as (SceneCue & { voice: SceneVoice }) | null
}

/** Where the element stops after this line: the next line can start at its end, where the clip goes on. Equal lines share audio, so the same clip alone does not say that. */
function voiceStop(cues: readonly SceneCue[], line: SceneCue & { voice: SceneVoice }): number {
  const same = (a: number, b: number): boolean => Math.abs(a - b) < SAME_S
  let last = line
  for (;;) {
    const { at, dur, voice } = last
    const next = cues.find((cue) => cue.at > at && cue.voice?.clip === voice.clip && same(cue.at, at + dur) && same(cue.voice.from, voice.from + dur))
    if (!next) return at + dur
    last = next as SceneCue & { voice: SceneVoice }
  }
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
  lineEnd = setTimeout(stopVoice, (voiceStop(cues, line) - t) * 1000)
}

/** No voice now: a line ended, or no scene shows. */
export function stopVoice(): void {
  clearTimeout(lineEnd)
  audio?.pause()
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopVoice()
    stopListening()
  })
