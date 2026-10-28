import { useSyncExternalStore } from 'react'
import type { BoardNode } from '@shared/board-format'
import { nodeSig, storyOnBoard, type BoardLook, type BoardStories, type BoardStory, type SceneStory } from '@shared/scene-story'

/**
 * The stories of the open board's scenes, from its scene records (main/scene-store.ts sends them
 * when the board mounts and after each new record line). Read-only here: main is the only writer.
 *
 * The index node id → scene lines is built once per records change and read by every read (agent
 * reads, the scene pill, the reading panel). It covers every scene line main knows in this run,
 * the newest and the earlier ones, dropped scenes too: an undo of a replace, a cut or clear_queue
 * puts earlier content back on the board. Which version a read shows is decided by what the board
 * shows (versionOnBoard), never by a flag.
 */

/** A node in one scene line: step is an index into that story's steps, or null. */
export interface NodeStory {
  scene: BoardStory
  story: SceneStory
  step: number | null
  made: boolean
}

let current: BoardStories | null = null
let byNode = new Map<string, NodeStory[]>()
const listeners = new Set<() => void>()

function buildIndex(stories: readonly BoardStory[]): Map<string, NodeStory[]> {
  const map = new Map<string, NodeStory[]>()
  for (const scene of stories) {
    for (const story of [...scene.earlier.map((entry) => entry.story), scene.story]) {
      for (const item of story.items) {
        for (const node of item.nodes) {
          const list = map.get(node) ?? []
          list.push({ scene, story, step: item.step, made: item.made })
          map.set(node, list)
        }
      }
    }
  }
  // The scene line that made a node first; the ones that changed it after.
  for (const list of map.values()) list.sort((a, b) => Number(b.made) - Number(a.made))
  return map
}

/** The open board's stories (from main), or null when the board has none or could not be read. */
export function setStories(value: BoardStories | null): void {
  current = value
  byNode = buildIndex(value?.stories ?? [])
  for (const listener of listeners) listener()
}

/** The open board's stories, re-rendering when they change (the scene pill and the panel). */
export function useBoardStories(): BoardStories | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current
  )
}

/** The stories of the board with this id, in reading order. */
export function storiesOf(boardId: string | undefined): readonly BoardStory[] {
  return current && boardId && current.id === boardId ? current.stories : []
}

/** Every scene line that made or changed this node (the ones that made it first), for the board with this id. */
export function storiesOfNode(boardId: string | undefined, nodeId: string): readonly NodeStory[] {
  return current && boardId && current.id === boardId ? (byNode.get(nodeId) ?? []) : []
}

/** What the board shows, for version checks: node presence and content signatures (computed when asked, once each). */
export function lookOf(nodes: readonly BoardNode[] | ReadonlyMap<string, BoardNode>): BoardLook {
  const byId = nodes instanceof Map ? (nodes as ReadonlyMap<string, BoardNode>) : new Map((nodes as readonly BoardNode[]).map((node) => [node.id, node]))
  const sigs = new Map<string, string>()
  return {
    has: (id) => byId.has(id),
    sig: (id) => {
      const node = byId.get(id)
      if (!node) return undefined
      let sig = sigs.get(id)
      if (sig === undefined) sigs.set(id, (sig = nodeSig(node)))
      return sig
    }
  }
}

/** The version of a scene that the board shows: the newest scene line whose made nodes are there or whose changed nodes have the content it left; else null. */
export function versionOnBoard(scene: BoardStory, look: BoardLook): SceneStory | null {
  if (storyOnBoard(scene.story, look)) return scene.story
  for (let i = scene.earlier.length - 1; i >= 0; i--) if (storyOnBoard(scene.earlier[i].story, look)) return scene.earlier[i].story
  return null
}

/** The scenes of the board for the learner: newest first (by when their newest version played), dropped ones left out. */
export function scenesNewestFirst(value: BoardStories | null): BoardStory[] {
  return (value?.stories ?? []).filter((story) => !story.dropped).sort((a, b) => b.at.localeCompare(a.at))
}
