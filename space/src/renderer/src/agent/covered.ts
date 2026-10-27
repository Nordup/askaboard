import type { BoardHandle } from '../board/Board'
import { screenToBoard } from '../board/geometry'
import type { Region } from '../board/types'
import { scriptPanelArea } from '../components/ScriptPanel'
import { toolPaletteArea } from '../components/ToolPalette'

/**
 * Parts of the learner's view that app UI covers while scenes play (the
 * script panel and the tool palette), in board
 * points: the learner cannot see board material there. get_board and
 * board.view list them, space() keeps clear of them, and preview_scene
 * images mark them.
 */

export interface Covered extends Region {
  by: string
}

export function coveredOf(board: BoardHandle): Covered[] {
  const host = document.querySelector<HTMLElement>('.canvas > .board')
  if (!host) return []
  const state = board.liveState()
  const frame = host.getBoundingClientRect()
  const r1 = (value: number): number => Math.round(value * 10) / 10
  const out: Covered[] = []
  for (const [by, area] of [['script panel', scriptPanelArea()], ['tool palette', toolPaletteArea()]] as const) {
    if (!area) continue
    // Only the part over the board counts.
    const left = Math.max(area.left, frame.left)
    const top = Math.max(area.top, frame.top)
    const right = Math.min(area.right, frame.right)
    const bottom = Math.min(area.bottom, frame.bottom)
    if (right <= left || bottom <= top) continue
    const [x, y] = screenToBoard([left - frame.left, top - frame.top], state.viewport, state.camera)
    out.push({ x: r1(x), y: r1(y), width: r1((right - left) / state.camera.zoom), height: r1((bottom - top) / state.camera.zoom), by })
  }
  return out
}
