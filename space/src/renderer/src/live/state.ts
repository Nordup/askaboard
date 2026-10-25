import { useSyncExternalStore } from 'react'

/**
 * Live-scene playback state for the app's UI (the scene pill and the
 * script panel): one small store that the scene player keeps up to date,
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

/** A scene that plays or waits in the queue: its id, the scene it replays (else its own id), name, lines and steps. */
export interface SceneListEntry {
  id: string
  /** The committed scene it plays (a replay "s2~r1" plays "s2"). */
  of: string
  name: string | null
  cues: SceneCueEntry[]
  steps: SceneStepEntry[]
}

export interface SceneUiState {
  playing: boolean
  paused: boolean
  sceneName: string | null
  /** The committed scene that shows now (for a replay, the scene it replays). */
  sceneOf: string | null
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
  /** The scenes that play or wait, in queue order (the same entries while the scenes are the same). */
  scenes: SceneListEntry[]
}

const IDLE: SceneUiState = { playing: false, paused: false, sceneName: null, sceneOf: null, stepName: null, stepIndex: -1, stepCount: 0, t: 0, duration: 0, queue: 0, currentCue: null, cues: [], steps: [], scenes: [] }

/** What the app's UI can ask the player to do. */
export interface SceneUiActions {
  pause(): void
  resume(): void
  /** Go to the start of the next step of the scene that shows (or end it, when it has no next step). */
  nextStep(): void
  /** End what plays and waits, then play these committed scenes again in order, the first from one of its steps. False when one can no longer be replayed. */
  replay(list: Array<{ scene: string; step?: string }>): boolean
}

let state: SceneUiState = IDLE
const listeners = new Set<() => void>()
let actions: SceneUiActions = { pause: () => undefined, resume: () => undefined, nextStep: () => undefined, replay: () => false }

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
    a.sceneOf === b.sceneOf &&
    a.scenes.length === b.scenes.length &&
    a.scenes.every((entry, i) => entry === b.scenes[i]) &&
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
  updateScript(value)
  for (const listener of listeners) listener()
}

/** The player registers what the UI's actions do. */
export function setSceneUiActions(next: SceneUiActions): void {
  actions = next
}

export function getSceneUiState(): SceneUiState {
  return state
}

export function subscribeSceneUi(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The playback state, re-rendering when it changes; with the UI's actions. */
export function useSceneState(): SceneUiState & SceneUiActions {
  const value = useSyncExternalStore(subscribeSceneUi, getSceneUiState)
  return { ...value, pause: () => actions.pause(), resume: () => actions.resume(), nextStep: () => actions.nextStep(), replay: (list) => actions.replay(list) }
}

/**
 * The script: the scenes that played as one explanation, for the script
 * panel. Scenes that follow each other without a stop (beats queued back to
 * back) are one script. A new script starts when nothing played and a scene
 * starts that is not part of the last script (a replay of one of its scenes
 * keeps it). It stays after the end, until another script starts or the
 * board changes.
 */
export interface SceneScript {
  /** Grows by one for each new script. */
  id: number
  /** Its scenes in the order they first played (each by the committed scene id). */
  scenes: SceneListEntry[]
  /** The index of the scene that shows now, or -1 when nothing plays. */
  current: number
  /** Nothing plays now: the script played to its end (or was stopped). */
  finished: boolean
}

let script: SceneScript | null = null
let scriptIds = 0

function updateScript(value: SceneUiState): void {
  if (!value.playing || !value.sceneOf) {
    if (script && !script.finished) script = { ...script, current: -1, finished: true }
    return
  }
  let scenes = script?.scenes ?? []
  let id = script?.id ?? 0
  if (!script || (script.finished && !scenes.some((entry) => entry.of === value.sceneOf))) {
    scenes = []
    id = ++scriptIds
  }
  let changed = !script || id !== script.id
  for (const entry of value.scenes) {
    const at = scenes.findIndex((known) => known.of === entry.of)
    if (at < 0) {
      scenes = [...scenes, entry]
      changed = true
    } else if (scenes[at] !== entry) {
      // A replay, or a scene committed again (replace): its lines and steps of now.
      scenes = scenes.map((known, i) => (i === at ? entry : known))
      changed = true
    }
  }
  const current = scenes.findIndex((entry) => entry.of === value.sceneOf)
  if (changed || !script || script.current !== current || script.finished) script = { id, scenes, current, finished: false }
}

/** The board changed or went away: its script goes. */
export function clearSceneScript(): void {
  script = null
  for (const listener of listeners) listener()
}

export function getSceneScript(): SceneScript | null {
  return script
}

/** The current script (null before the first scene with this board), re-rendering when it changes. */
export function useSceneScript(): SceneScript | null {
  return useSyncExternalStore(subscribeSceneUi, getSceneScript)
}
