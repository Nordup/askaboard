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
  /** The first step named after the scene (lines before the first step(); shared/scene-story.ts stepLines). */
  lead?: boolean
  /** Its lines: indexes into the scene's cues. */
  lines: number[]
}

/** A scene that plays or waits in the queue: its id, the scene it replays (else its own id), name, lines and steps. */
export interface SceneListEntry {
  id: string
  /** The committed scene it plays (a replay "s2~r1" plays "s2"). */
  of: string
  name: string | null
  cues: SceneCueEntry[]
  steps: SceneStepEntry[]
  /** The board items (node ids) it draws, moves or changes: its own and earlier material it acts on. */
  items: string[]
}

export interface SceneUiState {
  playing: boolean
  paused: boolean
  /** Why the scene is paused: a pause step, the learner drawing, or play_scene / the panel. */
  pausedBy: 'pause step' | 'learner drawing' | 'play_scene pause' | null
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

const IDLE: SceneUiState = { playing: false, paused: false, pausedBy: null, sceneName: null, sceneOf: null, stepName: null, stepIndex: -1, stepCount: 0, t: 0, duration: 0, queue: 0, currentCue: null, cues: [], steps: [], scenes: [] }

/** Where a scene plays from: a step (its number, from 1; a step goes by its place, never by its name) or a scene time in seconds (a line's own time). */
export type SceneStart = { step: number; at?: never } | { at: number; step?: never }

/** What the app's UI can ask the player to do. */
export interface SceneUiActions {
  pause(): void
  resume(): void
  /** Go to the start of the next step of the scene that shows (or end it, when it has no next step). */
  nextStep(): void
  /** End what plays and waits, then play these committed scenes again in order, the first from one of its moments. False when one can no longer be replayed. */
  replay(list: Array<{ scene: string } & Partial<SceneStart>>): boolean
  /** Play a committed scene from a moment (a step, or a scene time such as a line's): the scene that shows goes there; another scene is replayed from it. False when it can no longer be replayed. */
  playFrom(scene: string, from: SceneStart): boolean
  /** The player holds this committed scene, or can rebuild it from the board's records (after a restart), so it can play again (not after a new stage, nor when it could not be rebuilt). */
  canReplay(scene: string): boolean
  /** The exact scene time (seconds) of the scene that shows now, or null when none: for motion between the 0.1 s steps of `t` (the reading panel). */
  time(): number | null
}

let state: SceneUiState = IDLE
const listeners = new Set<() => void>()
let actions: SceneUiActions = { pause: () => undefined, resume: () => undefined, nextStep: () => undefined, replay: () => false, playFrom: () => false, canReplay: () => false, time: () => null }

function same(a: SceneUiState, b: SceneUiState): boolean {
  return (
    a.playing === b.playing &&
    a.paused === b.paused &&
    a.pausedBy === b.pausedBy &&
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
  return { ...value, pause: () => actions.pause(), resume: () => actions.resume(), nextStep: () => actions.nextStep(), replay: (list) => actions.replay(list), playFrom: (scene, from) => actions.playFrom(scene, from), canReplay: (scene) => actions.canReplay(scene), time: () => actions.time() }
}
