import type { BoardHandle } from '../board/Board'
import { screenToBoard } from '../board/geometry'
import type { Camera, Region } from '../board/types'
import { scriptPanelArea } from '../components/ScriptPanel'
import { toolPaletteArea } from '../components/ToolPalette'

/**
 * Parts of the learner's view that app UI covers while scenes play (the
 * script panel and the tool palette), in board
 * points: the learner cannot see board material there. list_items and
 * board.view list them, space() keeps clear of them, and preview_scene
 * images mark them in each frame. Each part is measured from its own element
 * (ScriptPanel, ToolPalette); it stays at its place on the screen, so its
 * board rect follows from the camera: the board's camera now, or the camera
 * of a moment of a scene (preview_scene).
 */

export interface Covered extends Region {
  by: string
}

export function coveredOf(board: BoardHandle, camera: Camera = board.liveState().camera): Covered[] {
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
    const [x, y] = screenToBoard([left - frame.left, top - frame.top], state.viewport, camera)
    out.push({ x: r1(x), y: r1(y), width: r1((right - left) / camera.zoom), height: r1((bottom - top) / camera.zoom), by })
  }
  return out
}
