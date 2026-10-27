import { isInk, type BoardNode } from '@shared/board-format'
import type { Scene } from './placement'

/**
 * The one rule for an item's name as its id. A name belongs to a node with
 * that name (not an ink stroke) or to named ink (an ink group whose strokes
 * all have that name); when several items have it, the latest one (the
 * highest seq) wins. An id comes first: a name is looked up only when no
 * item or ink group has that id.
 *
 * Scenes get the table as their context's names (live/run.ts sceneContext),
 * which board.node reads in the sandbox (stage/live-prelude.js); get_item
 * reads it with itemIdOf (agent/reads.ts).
 */
export function itemNames(s: Scene): Record<string, string> {
  const names: Record<string, { id: string; seq: number }> = {}
  const name = (key: unknown, id: string, seq: number): void => {
    if (typeof key !== 'string' || !key) return
    const known = names[key]
    if (!known || seq >= known.seq) names[key] = { id, seq }
  }
  for (const group of s.groups) {
    const strokes = group.strokes.map((id) => s.index.byId.get(id)).filter((node): node is BoardNode => !!node)
    const first = strokes[0]?.name
    if (first && strokes.every((node) => node.name === first)) name(first, group.id, Math.max(...strokes.map((node) => node.seq ?? 0)))
  }
  for (const node of s.nodes) {
    // Only items the board lays out (as the scene context lists them).
    if (!s.layout.get(node.id) || isInk(node)) continue
    name(node.name, node.id, node.seq ?? 0)
  }
  return Object.fromEntries(Object.entries(names).map(([key, value]) => [key, value.id]))
}

/** The id of an item or ink group given its id or its name (itemNames), or null. */
export function itemIdOf(s: Scene, key: string): string | null {
  if (s.index.byId.has(key) || s.groupById.has(key)) return key
  return itemNames(s)[key] ?? null
}
