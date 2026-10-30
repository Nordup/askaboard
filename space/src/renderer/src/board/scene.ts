import { isContent, isFrame, isInk, isInkHost, isKnown, newItemId, parentKey, ROOT, type NodeStyle } from '@shared/board-format'
import { inkBounds, inkLocalBounds, regionContains, strokeHitByCircle } from './geometry'
import type { NodeOverride } from './playback'
import type { BoardNode, ContentNode, InkNode, LayoutBox, Point, Region } from './types'

/**
 * The node tree: parent/child index, draw order, the layout cache and the
 * one shared hit test. Pure functions over immutable node arrays.
 */

export { parentKey, ROOT }

export interface SceneIndex {
  byId: Map<string, BoardNode>
  /** Children of each parent id (ROOT for top level), sorted by z (draw order). */
  children: Map<string, BoardNode[]>
}

const zOf = (node: BoardNode): number => (typeof node.z === 'number' && Number.isFinite(node.z) ? node.z : 0)

export function buildIndex(nodes: readonly BoardNode[]): SceneIndex {
  const byId = new Map<string, BoardNode>()
  for (const node of nodes) byId.set(node.id, node)
  const children = new Map<string, BoardNode[]>()
  const order = new Map<BoardNode, number>()
  nodes.forEach((node, index) => order.set(node, index))
  for (const node of nodes) {
    if (!isKnown(node)) continue
    let key = parentKey(node, byId)
    // A parent cycle would hide nodes: treat a node inside a cycle as top level.
    if (key !== ROOT && ancestorIds(node, byId).includes(node.id)) key = ROOT
    const list = children.get(key)
    if (list) list.push(node)
    else children.set(key, [node])
  }
  for (const list of children.values()) list.sort((a, b) => zOf(a) - zOf(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return { byId, children }
}

/** Parent ids from the nearest up to the top-level frame. Stops on cycles. */
export function ancestorIds(node: BoardNode, byId: ReadonlyMap<string, BoardNode>): string[] {
  const out: string[] = []
  let current: BoardNode | undefined = node
  const seen = new Set<string>([node.id])
  while (current) {
    const key = parentKey(current, byId)
    if (key === ROOT) break
    out.push(key)
    if (seen.has(key)) break
    seen.add(key)
    current = byId.get(key)
  }
  return out
}

/** The top-level ancestor of a node (the node itself when top level). */
export function topLevelOf(node: BoardNode, byId: ReadonlyMap<string, BoardNode>): BoardNode {
  const chain = ancestorIds(node, byId)
  return chain.length ? (byId.get(chain[chain.length - 1]) ?? node) : node
}

/** The ids and all their descendants. */
export function withDescendants(ids: Iterable<string>, index: SceneIndex): Set<string> {
  const out = new Set<string>()
  const stack = [...ids]
  while (stack.length) {
    const id = stack.pop() as string
    if (out.has(id)) continue
    out.add(id)
    for (const child of index.children.get(id) ?? []) stack.push(child.id)
  }
  return out
}

/** Drop ids whose ancestor is also in the set (moving the ancestor moves them). */
export function outermost(ids: Iterable<string>, byId: ReadonlyMap<string, BoardNode>): string[] {
  const set = new Set(ids)
  return [...set].filter((id) => {
    const node = byId.get(id)
    return node ? !ancestorIds(node, byId).some((ancestor) => set.has(ancestor)) : false
  })
}

/** True when the node's position comes from flex layout (a content child of a flex frame). */
export function isFlowed(node: BoardNode, byId: ReadonlyMap<string, BoardNode>): boolean {
  if (!isContent(node)) return false
  const key = parentKey(node, byId)
  if (key === ROOT) return false
  const parent = byId.get(key)
  return !!parent && isFrame(parent) && parent.style.display === 'flex'
}

/** Content nodes in paint order (depth first, parents before children, by z). */
export function contentPaintOrder(index: SceneIndex): ContentNode[] {
  const out: ContentNode[] = []
  const walk = (key: string): void => {
    for (const node of index.children.get(key) ?? []) {
      if (!isContent(node)) continue
      out.push(node)
      if (node.kind === 'frame') walk(node.id)
    }
  }
  walk(ROOT)
  return out
}

/** Ink nodes in draw order: top-level ink by z, then each frame's ink (frames in paint order). */
export function inkPaintOrder(index: SceneIndex): InkNode[] {
  const out: InkNode[] = []
  const walk = (key: string): void => {
    const list = index.children.get(key) ?? []
    for (const node of list) if (isInk(node)) out.push(node)
    for (const node of list) if (isInkHost(node)) walk(node.id)
  }
  walk(ROOT)
  return out
}

/** The z for a node placed on top of the given siblings. */
export function zAbove(siblings: readonly BoardNode[]): number {
  let max = 0
  for (const node of siblings) max = Math.max(max, zOf(node))
  return Math.floor(max) + 1
}

// ---------- Layout cache ----------

export type LayoutMap = Map<string, LayoutBox>

/** The world position of an ink node's local 0,0. */
export function inkOffset(node: InkNode, byId: ReadonlyMap<string, BoardNode>, layout: ReadonlyMap<string, LayoutBox>): Point {
  const key = parentKey(node, byId)
  if (key === ROOT) return [node.x, node.y]
  const parent = layout.get(key)
  if (parent) return [parent.ox + node.x, parent.oy + node.y]
  // Not measured yet: add up the ancestors' own positions.
  let x = node.x
  let y = node.y
  for (const id of ancestorIds(node, byId)) {
    const ancestor = byId.get(id)
    if (ancestor && isKnown(ancestor)) {
      x += ancestor.x
      y += ancestor.y
    }
  }
  return [x, y]
}

/** Add every ink node's world bounds to the layout map (content entries come from the DOM). */
export function addInkLayout(index: SceneIndex, layout: LayoutMap): void {
  for (const node of index.byId.values()) {
    if (!isInk(node)) continue
    const offset = inkOffset(node, index.byId, layout)
    const bounds = inkBounds(node, offset)
    if (bounds) layout.set(node.id, { ...bounds, ox: offset[0], oy: offset[1] })
    else layout.delete(node.id)
  }
}

// ---------- Hit testing ----------

/** Whether the learner sees a node now (shownNow, bound to the board's playback frame). */
export type Shown = (node: BoardNode) => boolean

/**
 * Whether the learner sees a node now. A scene that plays, is paused or waits
 * for its next step keeps its later items on the board, hidden by the playback
 * frame: an override with opacity 0 or with nothing drawn yet (reveal 0).
 * Every learner input that picks or changes items (erase, click, lasso, text
 * tool, select all) asks this, so no tool acts on what does not show. Content
 * also hides with a hidden ancestor (CSS opacity); ink paints on its own canvas,
 * where only its own override counts. null overrides: no scene plays.
 */
export function shownNow(node: BoardNode, byId: ReadonlyMap<string, BoardNode>, overrides: ReadonlyMap<string, NodeOverride> | null): boolean {
  if (!overrides?.size) return true
  const hidden = (id: string): boolean => {
    const override = overrides.get(id)
    return !!override && ((override.opacity !== undefined && override.opacity <= 0) || (override.reveal !== undefined && override.reveal <= 0))
  }
  if (hidden(node.id)) return false
  return isInk(node) || !ancestorIds(node, byId).some(hidden)
}

/** The top-most ink under a point that shows now: pen above highlighter, later above earlier. */
export function inkAt(index: SceneIndex, layout: ReadonlyMap<string, LayoutBox>, point: Point, radius: number, shown: Shown): InkNode | null {
  const strokes = inkPaintOrder(index)
  for (const tool of ['pen', 'highlighter'] as const) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i]
      if (stroke.tool !== tool || !shown(stroke)) continue
      const box = layout.get(stroke.id)
      const offset: Point = box ? [box.ox, box.oy] : inkOffset(stroke, index.byId, layout)
      if (strokeHitByCircle(stroke, offset, point, radius)) return stroke
    }
  }
  return null
}

/** The deepest, top-most content node that shows now and whose box contains the point. */
export function contentAt(index: SceneIndex, layout: ReadonlyMap<string, LayoutBox>, point: Point, shown: Shown): ContentNode | null {
  const order = contentPaintOrder(index)
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]
    if (node.style.display === 'none' || !shown(node)) continue
    const box = layout.get(node.id)
    if (box && regionContains(box, point)) return node
  }
  return null
}

/**
 * Which node a click selects (Figma rule): ink directly; for content, the
 * ancestor of the hit node whose parent is `scope` (ROOT = top level). When
 * the scope is not an ancestor of the hit, the top-level node.
 */
export function selectTarget(hit: BoardNode, scope: string, byId: ReadonlyMap<string, BoardNode>): BoardNode {
  if (isInk(hit)) return hit
  const chain = [hit.id, ...ancestorIds(hit, byId)] // nearest first
  if (scope !== ROOT) {
    const at = chain.indexOf(scope)
    if (at > 0) return byId.get(chain[at - 1]) ?? hit
  }
  return byId.get(chain[chain.length - 1]) ?? hit
}

// ---------- Edits (pure) ----------

/** Translate nodes by a world delta. Ink and free nodes change x, y. */
export function moveNodes(nodes: readonly BoardNode[], ids: ReadonlySet<string>, delta: Point): BoardNode[] {
  if (!ids.size || (!delta[0] && !delta[1])) return [...nodes]
  return nodes.map((node) =>
    ids.has(node.id) && isKnown(node) && !node.locked ? ({ ...node, x: node.x + delta[0], y: node.y + delta[1] } as BoardNode) : node
  )
}

/** Remove nodes and all their descendants. Locked nodes stay. */
export function removeNodes(nodes: readonly BoardNode[], ids: Iterable<string>, index: SceneIndex): BoardNode[] {
  const unlocked = [...ids].filter((id) => {
    const node = index.byId.get(id)
    return node && !(isKnown(node) && node.locked)
  })
  const gone = withDescendants(unlocked, index)
  return nodes.filter((node) => !gone.has(node.id))
}

/**
 * A copy of an item is not linked to any scene or step (founder decision, 2026-10-29): it
 * carries no scene tag. Every copy the board makes (copy, cut, duplicate, paste) goes through this.
 */
export function withoutScene<T extends BoardNode>(node: T): T {
  if (!('scene' in node)) return node
  const { scene: _scene, ...rest } = node as T & { scene?: unknown }
  return rest as T
}

/**
 * Copy nodes with their subtrees and fresh ids. Each root keeps its parent
 * (duplicate) or becomes top level at its world position (copy for paste).
 */
export interface Copied {
  nodes: BoardNode[]
  roots: string[]
  /** Old id → new id, descendants included. */
  idMap?: Map<string, string>
}

export function copySubtrees(
  ids: Iterable<string>,
  index: SceneIndex,
  layout: ReadonlyMap<string, LayoutBox>,
  options: { detach: boolean }
): Copied {
  const roots = outermost(ids, index.byId)
  const all = withDescendants(roots, index)
  const idMap = new Map<string, string>()
  for (const id of all) idMap.set(id, newItemId(index.byId.get(id)?.kind === 'ink' ? 's' : 'n'))
  const out: BoardNode[] = []
  for (const id of all) {
    const node = index.byId.get(id)
    if (!node) continue
    const copy = withoutScene(structuredClone(node)) as BoardNode & { parent?: string }
    copy.id = idMap.get(id) as string
    const isRoot = roots.includes(id)
    if (!isRoot && typeof node.parent === 'string') copy.parent = idMap.get(node.parent) ?? node.parent
    if (isRoot && options.detach && isKnown(node)) {
      delete copy.parent
      const box = layout.get(id)
      if (isInk(node)) {
        const offset = box ? [box.ox, box.oy] : [node.x, node.y]
        ;(copy as InkNode).x = offset[0]
        ;(copy as InkNode).y = offset[1]
      } else if (box) {
        ;(copy as ContentNode).x = box.x
        ;(copy as ContentNode).y = box.y
        // A flowed node gets its measured size, so it keeps its look outside the flex frame.
        if (isFlowed(node, index.byId)) {
          const style = { ...(copy as ContentNode).style } as NodeStyle
          if (!style.width) style.width = `${Math.round(box.width)}px`
          ;(copy as ContentNode).style = style
        }
      }
    }
    out.push(copy)
  }
  return { nodes: out, roots: roots.map((id) => idMap.get(id) as string), idMap }
}

/** The union of the layout boxes of some ids. */
export function boundsOf(ids: Iterable<string>, layout: ReadonlyMap<string, LayoutBox>): Region | null {
  let x = Infinity
  let y = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const id of ids) {
    const box = layout.get(id)
    if (!box) continue
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return Number.isFinite(x) ? { x, y, width: right - x, height: bottom - y } : null
}

/** Make ink points relative: x, y become the top-left of the points (rounded), points shift by it. */
export function normalizeInk(node: InkNode): InkNode {
  const local = inkLocalBounds(node)
  if (!local) return node
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of node.points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  const dx = Math.round(minX * 10) / 10
  const dy = Math.round(minY * 10) / 10
  return { ...node, x: node.x + dx, y: node.y + dy, points: node.points.map(([x, y, p]) => [x - dx, y - dy, p]) }
}
