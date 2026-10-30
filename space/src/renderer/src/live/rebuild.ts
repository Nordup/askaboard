import { useSyncExternalStore } from 'react'
import type { SceneSettle, SceneStory, StoryRevert } from '@shared/scene-story'

/**
 * The scenes of the stage that main rebuilt from the board's scene records (main/mcp.ts restoreStage):
 * after a restart, a switch to another board and back, or a window that loaded again, their items are
 * on the board but the player holds no play data of them. No play data is saved (decision B22: it is
 * too heavy): a replay asks main to run the scene's program again on the rebuilt stage
 * (requestRebuild), and run.ts sceneMemory compiles that run onto the board's own nodes through the
 * record (story.items); the player then keeps it as it keeps a scene committed in this session.
 * Main owns whether a scene's program can run (main/live-scene.ts StageEntry.failed); `failed` here
 * mirrors it for every scene of the stage (main/mcp.ts publishFailures), and the panel then says
 * that the scene could not be rebuilt.
 */

export interface RestoredScene {
  id: string
  name: string | null
  story: SceneStory
  revert: StoryRevert
  settle: SceneSettle | null
}

const scenes = new Map<string, RestoredScene>()
/** Why a scene of the stage cannot run again (main's StageEntry.failed), by scene id. */
const failed = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

/** The restored scenes of a stage (they replace the ones of an earlier stage). */
export function setRestored(list: RestoredScene[]): void {
  scenes.clear()
  for (const scene of list) scenes.set(scene.id, scene)
  changed()
}

/** A scene of this session whose stream was cut: from now on a replay rebuilds it, as a restored scene. */
export function addRestored(scene: RestoredScene): void {
  scenes.set(scene.id, scene)
  changed()
}

/** Main's failure state of the stage's programs, the full set (it replaces the one before). */
export function setFailed(list: ReadonlyArray<[string, string]>): void {
  failed.clear()
  for (const [id, why] of list) failed.set(id, why)
  changed()
}

/** A new stage, or another board: no restored scenes. */
export function clearRestored(): void {
  if (!scenes.size && !failed.size) return
  scenes.clear()
  failed.clear()
  changed()
}

export function restoredScene(id: string): RestoredScene | undefined {
  return scenes.get(id)
}

/** A scene committed again: its new commit, not its record, is what the player holds. */
export function forgetRestored(id: string): void {
  if (scenes.delete(id)) changed()
}

/** A restored scene whose program can run again for a replay. */
export function canRebuild(id: string): boolean {
  return scenes.has(id) && !failed.has(id)
}

/** Why a scene's program cannot run again (it could not be rebuilt), or null. */
export function rebuildFailure(id: string): string | null {
  return failed.get(id) ?? null
}

/** Re-renders when the restored scenes or their failures change (the script panel's status). */
export function useRestoredVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version
  )
}

/** Ask main to run these restored scenes' programs again and give the player their play data (resolves when it did, or could not). */
export async function requestRebuild(ids: string[]): Promise<void> {
  try {
    await window.space.rebuildScenes(ids)
  } catch (error) {
    // Main owns whether a scene can be rebuilt: a request that did not reach it changes nothing here.
    console.warn(`the scenes ${ids.join(', ')} were not rebuilt: ${error instanceof Error ? error.message : String(error)}`)
  }
}
