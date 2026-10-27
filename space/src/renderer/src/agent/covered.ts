import type { BoardHandle } from '../board/Board'
import { screenToBoard } from '../board/geometry'
import type { Region } from '../board/types'

/**
 * Parts of the learner's view that app UI covers now, in board points: the
 * learner cannot see board material there. get_canvas_info and board.view
 * list them, and space() keeps clear of them.
 */

export interface Covered extends Region {
  by: string
}

/** The UI that floats over the board, while it shows (the script panel, open or minimised to its bar). */
const COVERS: ReadonlyArray<{ selector: string; by: string }> = [{ selector: '.script-panel.is-shown', by: 'script panel' }]

export function coveredOf(board: BoardHandle): Covered[] {
  const host = document.querySelector<HTMLElement>('.canvas > .board')
  if (!host) return []
  const state = board.liveState()
  const frame = host.getBoundingClientRect()
  const out: Covered[] = []
  for (const { selector, by } of COVERS) {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) continue
    const box = element.getBoundingClientRect()
    // Only the part over the board counts.
    const left = Math.max(box.left, frame.left)
    const top = Math.max(box.top, frame.top)
    const right = Math.min(box.right, frame.right)
    const bottom = Math.min(box.bottom, frame.bottom)
    if (right <= left || bottom <= top) continue
    const [x, y] = screenToBoard([left - frame.left, top - frame.top], state.viewport, state.camera)
    const r1 = (value: number): number => Math.round(value * 10) / 10
    out.push({ x: r1(x), y: r1(y), width: r1((right - left) / state.camera.zoom), height: r1((bottom - top) / state.camera.zoom), by })
  }
  return out
}
