import type { BoardNode, ContentNode, FrameNode, ImageNode, InkNode, PaintedNode, ShapeNode, SvgNode, TextNode } from '@shared/board-format'
import type { Camera } from '@shared/space-api'

export type { BoardNode, Camera, ContentNode, FrameNode, ImageNode, InkNode, PaintedNode, ShapeNode, SvgNode, TextNode }

/** A 2D point: board points or screen (CSS) pixels, by context. */
export type Point = [number, number]

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** A box that can turn about its centre: `rotation` in degrees, clockwise (rotation.ts). */
export interface TurnedRegion extends Region {
  rotation?: number
}

/**
 * One entry of the layout cache: a node's world box in board points.
 * `ox, oy` is the origin of the node's children (for a frame, the top-left of
 * its padding box: the CSS containing block); for other nodes it equals x, y.
 * A turned item has the box before it turns and its `rotation`. The layout that
 * readers outside the board get (rotation.ts placedLayout) has its bounds on
 * the board in place of that, and the box before it turns in `own`.
 */
export interface LayoutBox extends TurnedRegion {
  ox: number
  oy: number
  own?: LayoutBox
}
