import type { BoardNode, ContentNode, FrameNode, ImageNode, InkNode, SvgNode, TextNode } from '@shared/board-format'
import type { Camera } from '@shared/space-api'

export type { BoardNode, Camera, ContentNode, FrameNode, ImageNode, InkNode, SvgNode, TextNode }

/** A 2D point: board points or screen (CSS) pixels, by context. */
export type Point = [number, number]

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One entry of the layout cache: a node's world bounds in board points.
 * `ox, oy` is the origin of the node's children (for a frame, the top-left of
 * its padding box: the CSS containing block); for other nodes it equals x, y.
 */
export interface LayoutBox extends Region {
  ox: number
  oy: number
}
