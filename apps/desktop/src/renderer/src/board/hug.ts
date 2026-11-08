import { hugsChildren, isPainted, type BoardNode, type FrameNode } from '@shared/board-format'
import { placedBox } from './rotation'
import type { LayoutBox } from './types'

/** The gap between a hugging frame's edges and the items it holds, in board points. */
export const HUG_PAD = 6

/**
 * Hugging frames (a group's frame, FrameNode.hug) placed and sized on the items they hold, as the board
 * measures them now: the one rule for such a frame's box, applied after a scene commits (live/run.ts
 * settleLayout) and after every measure of the board (Board.tsx fitHugs), so the box follows its items
 * when a text changes, a font loads or an item moves. A frame's box is the bounds of its children
 * (a turned child by its turned bounds, ink with its stroke width) plus HUG_PAD; the children keep
 * their world place. Innermost frames first, so an outer frame holds an inner frame's new box.
 * Returns the changed nodes, or null when every hugging frame already fits.
 */
export function huggedNodes(nodes: readonly BoardNode[], layout: ReadonlyMap<string, LayoutBox>): BoardNode[] | null {
  const frames = nodes.filter(hugsChildren)
  if (!frames.length) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depth = (node: BoardNode): number => {
    let d = 0
    for (let parent = node.parent as string | undefined; typeof parent === 'string' && d < 64; parent = byId.get(parent)?.parent as string | undefined) d++
    return d
  }
  const children = new Map<string, BoardNode[]>()
  for (const node of nodes) {
    const parent = node.parent as string | undefined
    if (typeof parent !== 'string') continue
    const list = children.get(parent)
    if (list) list.push(node)
    else children.set(parent, [node])
  }
  const boxes = new Map(layout)
  const changed = new Map<string, BoardNode>()
  for (const frame of [...frames].sort((a, b) => depth(b) - depth(a))) {
    const box = boxes.get(frame.id)
    if (!box) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const node of children.get(frame.id) ?? []) {
      const measured = boxes.get(node.id)
      if (!measured) continue
      const child = placedBox(measured)
      const pad = isPainted(node) ? node.width : 0
      x0 = Math.min(x0, child.x - pad)
      y0 = Math.min(y0, child.y - pad)
      x1 = Math.max(x1, child.x + child.width + pad)
      y1 = Math.max(y1, child.y + child.height + pad)
    }
    if (x0 === Infinity) continue
    const nx = Math.floor(x0 - HUG_PAD)
    const ny = Math.floor(y0 - HUG_PAD)
    const dx = nx - box.x
    const dy = ny - box.y
    const w = Math.ceil(x1 - nx + HUG_PAD)
    const h = Math.ceil(y1 - ny + HUG_PAD)
    const width = `${w}px`
    const height = `${h}px`
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && frame.style.width === width && frame.style.height === height) continue
    const current = (changed.get(frame.id) ?? frame) as FrameNode
    changed.set(frame.id, { ...current, x: r1(current.x + dx), y: r1(current.y + dy), hug: `${width} ${height}`, style: { ...current.style, width, height } })
    // The children keep their world place: their x, y are relative to the frame.
    for (const node of children.get(frame.id) ?? []) {
      const now = changed.get(node.id) ?? node
      changed.set(node.id, { ...now, x: r1((now.x as number) - dx), y: r1((now.y as number) - dy) } as BoardNode)
    }
    boxes.set(frame.id, { ...box, x: nx, y: ny, width: w, height: h, ox: box.ox + dx, oy: box.oy + dy })
  }
  if (!changed.size) return null
  return nodes.map((node) => changed.get(node.id) ?? node)
}

function r1(value: number): number {
  return Math.round(value * 10) / 10
}
