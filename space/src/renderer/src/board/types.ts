import type { BoardItem, StrokeItem } from '@shared/board-format'
import type { Camera } from '@shared/space-api'

export type { BoardItem, Camera, StrokeItem }

/** A 2D point: board points or screen (CSS) pixels, by context. */
export type Point = [number, number]

export interface Region {
  x: number
  y: number
  width: number
  height: number
}
