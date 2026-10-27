import type { BoardHandle } from '../board/Board'
import { screenToBoard } from '../board/geometry'
import type { Region } from '../board/types'
import { scriptPanelArea } from '../components/ScriptPanel'

/**
 * Parts of the learner's view that app UI covers while scenes play, in board
 * points: the learner cannot see board material there. get_canvas_info and
 * board.view list them, space() keeps clear of them, and preview_scene
 * images mark them.
 */

export interface Covered extends Region {
  by: string
}

export function coveredOf(board: BoardHandle): Covered[] {
  const host = document.querySelector<HTMLElement>('.canvas > .board')
  const area = scriptPanelArea()
  if (!host || !area) return []
  const state = board.liveState()
  const frame = host.getBoundingClientRect()
  // Only the part over the board counts.
  const left = Math.max(area.left, frame.left)
  const top = Math.max(area.top, frame.top)
  const right = Math.min(area.right, frame.right)
  const bottom = Math.min(area.bottom, frame.bottom)
  if (right <= left || bottom <= top) return []
  const [x, y] = screenToBoard([left - frame.left, top - frame.top], state.viewport, state.camera)
  const r1 = (value: number): number => Math.round(value * 10) / 10
  return [{ x: r1(x), y: r1(y), width: r1((right - left) / state.camera.zoom), height: r1((bottom - top) / state.camera.zoom), by: 'script panel' }]
}
