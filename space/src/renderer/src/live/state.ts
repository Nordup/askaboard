import { useSyncExternalStore } from 'react'

/**
 * Live-scene playback state for the app's UI (captions, a panel of the
 * tutor's words): one small store that the scene player keeps up to date,
 * and a React hook to read it. Nothing is spoken: a say() line is text the
 * learner reads, timed at a reading pace (3.5 words a second, see
 * live-prelude.js measureLine).
 */

/** The line (say) on screen now. */
export interface SceneCueState {
  text: string
  at_s: number
  dur_s: number
  /** The words read so far at the reading pace (whole words, from the start of the line). */
  readSoFar: string
  /** The share of the line's time that has passed, 0..1. */
  progress: number
}

/** One line (say) of the current scene, with its time on the scene's timeline. */
export interface SceneCueEntry {
  text: string
  at_s: number
  dur_s: number
  /** Marks ([[name]] in the line): name → scene time. */
  marks?: Record<string, number>
}

/** One step of the current scene. */
export interface SceneStepEntry {
  name: string
  at_s: number
  pause?: boolean
}

export interface SceneUiState {
  playing: boolean
  paused: boolean
  sceneName: string | null
  stepName: string | null
  /** 0-based index of the current step, or -1 before the first one. */
  stepIndex: number
  stepCount: number
  /** Scene time in seconds (0.1 s steps). */
  t: number
  duration: number
  /** Scenes waiting after this one. */
  queue: number
  currentCue: SceneCueState | null
  /** Every line of the current scene, in order (the same array while the scene is the same). */
  cues: SceneCueEntry[]
  /** Every step of the current scene, in order (the same array while the scene is the same). */
  steps: SceneStepEntry[]
}

const IDLE: SceneUiState = { playing: false, paused: false, sceneName: null, stepName: null, stepIndex: -1, stepCount: 0, t: 0, duration: 0, queue: 0, currentCue: null, cues: [], steps: [] }

let state: SceneUiState = IDLE
const listeners = new Set<() => void>()
let actions: { pause(): void; resume(): void } = { pause: () => undefined, resume: () => undefined }

function same(a: SceneUiState, b: SceneUiState): boolean {
  return (
    a.playing === b.playing &&
    a.paused === b.paused &&
    a.sceneName === b.sceneName &&
    a.stepName === b.stepName &&
    a.stepIndex === b.stepIndex &&
    a.stepCount === b.stepCount &&
    a.t === b.t &&
    a.duration === b.duration &&
    a.queue === b.queue &&
    a.currentCue?.text === b.currentCue?.text &&
    a.currentCue?.at_s === b.currentCue?.at_s &&
    a.currentCue?.readSoFar === b.currentCue?.readSoFar &&
    a.cues === b.cues &&
    a.steps === b.steps
  )
}

/** The player sets the state (it notifies only when something shows differently). */
export function setSceneUiState(next: SceneUiState | null): void {
  const value = next ?? IDLE
  if (same(value, state)) return
  state = value
  for (const listener of listeners) listener()
}

/** The player registers what pause() and resume() do. */
export function setSceneUiActions(next: { pause(): void; resume(): void }): void {
  actions = next
}

export function getSceneUiState(): SceneUiState {
  return state
}

export function subscribeSceneUi(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The playback state, re-rendering when it changes; with pause() and resume(). */
export function useSceneState(): SceneUiState & { pause(): void; resume(): void } {
  const value = useSyncExternalStore(subscribeSceneUi, getSceneUiState)
  return { ...value, pause: () => actions.pause(), resume: () => actions.resume() }
}
