import { useSyncExternalStore } from 'react'
import type { SettingsChange, SettingsSnapshot } from '@shared/space-api'
import { errorMessage } from './errors'

/**
 * The renderer's one copy of the user settings: a mirror of main/settings.ts, which owns them (decision U12). One
 * subscription to main's snapshot serves the Settings dialog, the top bar (Show performance) and the board's voice
 * (Read lines aloud); every change goes back to main (changeSettings), never into a local copy.
 */

type Listener = (settings: SettingsSnapshot) => void

let current: SettingsSnapshot | null = null
const listeners = new Set<Listener>()
let started = false

function take(next: SettingsSnapshot): void {
  current = next
  for (const listener of listeners) listener(next)
}

function start(): void {
  // A window without the main window's API (the snapshot window) has no settings.
  if (started || !window.space?.onSettings) return
  started = true
  window.space.onSettings(take)
  // A push that came first is newer than this answer.
  void window.space.getSettings().then((first) => {
    if (!current) take(first)
  })
}

/** Every snapshot from now on, and the current one at once when there is one. */
export function subscribeSettings(listener: Listener): () => void {
  start()
  listeners.add(listener)
  if (current) listener(current)
  return () => {
    listeners.delete(listener)
  }
}

const subscribe = (notify: () => void): (() => void) => subscribeSettings(notify)

/** The snapshot, or null until main answers. */
export function useSettings(): SettingsSnapshot | null {
  return useSyncExternalStore(subscribe, () => current)
}

/** One value of the snapshot (a component re-renders only when it changes), or the fallback until main answers. */
export function useSetting<T>(select: (settings: SettingsSnapshot) => T, fallback: T): T {
  return useSyncExternalStore(subscribe, () => (current ? select(current) : fallback))
}

/** Send a change to main; the new snapshot comes back through the subscription. */
export function changeSettings(change: SettingsChange): void {
  void window.space.setSettings(change).catch((error: unknown) => console.error(`settings: ${errorMessage(error)}`))
}
