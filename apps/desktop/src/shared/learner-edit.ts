import { isInk, isKnown, isShape, type BoardDoc } from './board-format'

/**
 * The learner's new or changed nodes in one save: the body of a learner_edit
 * trace line. The renderer computes it from the board it saves, so the main
 * process does not parse the saved file again.
 */
export interface LearnerEditDelta {
  ids: string[]
  strokes: number
  bounds: { x: number; y: number; width: number; height: number } | null
}

/**
 * The learner nodes whose seq is at or past `since` (the board's nextSeq at
 * the last read or save). Null when there are none.
 */
export function learnerEditSince(doc: BoardDoc, since: number): LearnerEditDelta | null {
  const ids: string[] = []
  let strokes = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of doc.nodes) {
    if (node.seq < since || !isKnown(node) || node.author !== 'learner') continue
    ids.push(node.id)
    const half = (isInk(node) || isShape(node) ? node.width : 0) / 2
    if (isShape(node)) {
      // Its box (or the line from its start to its end), with half its width: the wobble stays inside that.
      minX = Math.min(minX, node.x, node.x + node.w) - half
      minY = Math.min(minY, node.y, node.y + node.h) - half
      maxX = Math.max(maxX, node.x, node.x + node.w) + half
      maxY = Math.max(maxY, node.y, node.y + node.h) + half
      continue
    }
    if (!isInk(node)) continue
    strokes++
    for (const [px, py] of node.points) {
      const x = node.x + px
      const y = node.y + py
      minX = Math.min(minX, x - half)
      minY = Math.min(minY, y - half)
      maxX = Math.max(maxX, x + half)
      maxY = Math.max(maxY, y + half)
    }
  }
  if (!ids.length) return null
  const bounds =
    Number.isFinite(minX)
      ? { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) }
      : null
  return { ids, strokes, bounds }
}
