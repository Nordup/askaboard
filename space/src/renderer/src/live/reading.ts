import { useSyncExternalStore } from 'react'
import type { BoardNode } from '@shared/board-format'

/**
 * What the reading panel and the scene pill share (decision B19): the scene the learner chose
 * from the pill's menu, whether the learner hid the panel into the pill, the pill's one flash
 * after a hide, and the board selection (the pill shows a selected item's step).
 * The scene that plays always comes from the player (live/state.ts); the stories from the
 * records (live/stories.ts). The state belongs to the open board: it starts again when another
 * board opens (setReadingBoard).
 */
export interface ReadingState {
  /** A committed scene the learner opened from the pill's menu (shown in its ended state), or null. */
  chosen: string | null
  /** The learner hid the panel into the pill (minus). A scene that starts after nothing played shows it again. */
  hidden: boolean
  /** Grows by one when the panel went into the pill: the pill lights up once. */
  flash: number
  /** The panel opens from the pill (it grows out of it) the next time it shows. */
  fromPill: boolean
  /** The selected node ids on the board. */
  selection: readonly string[]
  /** The committed scene the panel shows now, or null (the pill's menu checks it). */
  panelScene: string | null
}

let state: ReadingState = { chosen: null, hidden: false, flash: 0, fromPill: false, selection: [], panelScene: null }
let board: string | null = null
let nodes: () => readonly BoardNode[] = () => []

/** The open board (its path, or null): another board starts the reading state again. */
export function setReadingBoard(path: string | null): void {
  if (path === board) return
  board = path
  set({ chosen: null, hidden: false, fromPill: false, selection: [], panelScene: null })
}

/** Where the panel and the pill read the board's nodes (which version of a scene it shows). */
export function setBoardNodes(source: () => readonly BoardNode[]): void {
  nodes = source
}

export function boardNodes(): readonly BoardNode[] {
  return nodes()
}
const listeners = new Set<() => void>()

function set(next: Partial<ReadingState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function useReading(): ReadingState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}

/** The pill's menu: show this scene in the panel (it grows out of the pill). */
export function chooseScene(scene: string): void {
  set({ chosen: scene, hidden: false, fromPill: true })
}

/** The panel went into the pill. */
export function hidePanel(): void {
  set({ hidden: true, chosen: null, flash: state.flash + 1 })
}

/** A scene started after nothing played: the panel shows it (also after a hide); a chosen scene gives way. */
export function sceneStarted(): void {
  if (state.hidden || state.chosen) set({ hidden: false, chosen: null })
}

/** The panel has grown out of the pill. */
export function openedFromPill(): void {
  if (state.fromPill) set({ fromPill: false })
}

export function setSelection(ids: readonly string[]): void {
  if (ids.length === state.selection.length && ids.every((id, i) => id === state.selection[i])) return
  set({ selection: [...ids] })
}

/** The panel reports the scene it shows. */
export function setPanelScene(scene: string | null): void {
  if (state.panelScene !== scene) set({ panelScene: scene })
}
