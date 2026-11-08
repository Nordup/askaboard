import type { LayoutBox, Point, Region, TurnedRegion } from './types'

/**
 * Turned items: the one owner of their geometry. A turned box is the box of the
 * item before it turns, and its rotation in degrees, clockwise about its centre
 * (board +y is down). "Share" is a place in the box as fractions of its size:
 * [0, 0] is its top-left corner, [1, 0.5] the middle of its east edge.
 */

/** A saved rotation inside a transform that has its origin at the element's top-left (playback.ts). The app's board CSS sets --node-rotation. */
export const OWN_ROTATION = 'translate(50%, 50%) rotate(var(--node-rotation)) translate(-50%, -50%)'

const radians = (degrees: number): number => (degrees * Math.PI) / 180

export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  const x = point[0] - center[0]
  const y = point[1] - center[1]
  return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos]
}

export function centerOf(box: Region): Point {
  return [box.x + box.width / 2, box.y + box.height / 2]
}

/** Where a place in the box shows on the board. */
export function pointOnBox(box: Region, share: Point, degrees: number): Point {
  return rotatePoint([box.x + box.width * share[0], box.y + box.height * share[1]], centerOf(box), degrees)
}

/** A board point in the frame of the box before it turns. */
export function unturned(box: TurnedRegion, point: Point): Point {
  return box.rotation ? rotatePoint(point, centerOf(box), -box.rotation) : point
}

/** The box of `size`, turned by `degrees`, that has the place `share` at the board point `anchor`. */
export function boxThrough(anchor: Point, share: Point, size: Point, degrees: number): Region {
  const [dx, dy] = rotatePoint([(share[0] - 0.5) * size[0], (share[1] - 0.5) * size[1]], [0, 0], degrees)
  return { x: anchor[0] - dx - size[0] / 2, y: anchor[1] - dy - size[1] / 2, width: size[0], height: size[1] }
}

/** The axis-aligned bounds of a turned box. */
export function turnedBounds(box: TurnedRegion): Region {
  const degrees = box.rotation ?? 0
  if (!degrees) return { x: box.x, y: box.y, width: box.width, height: box.height }
  const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as Point[]).map((share) => pointOnBox(box, share, degrees))
  const x = Math.min(...corners.map((corner) => corner[0]))
  const y = Math.min(...corners.map((corner) => corner[1]))
  return { x, y, width: Math.max(...corners.map((corner) => corner[0])) - x, height: Math.max(...corners.map((corner) => corner[1])) - y }
}

/** Where a box is on the board: its axis-aligned bounds, with the box before it turns in `own`. A box that does not turn is itself. */
export function placedBox(box: LayoutBox): LayoutBox {
  return box.rotation ? { ...turnedBounds(box), ox: box.ox, oy: box.oy, own: box } : box
}

/** The layout as readers outside the board want it: every box where it is on the board. The same map when nothing turns. */
export function placedLayout(layout: ReadonlyMap<string, LayoutBox>): ReadonlyMap<string, LayoutBox> {
  let out: Map<string, LayoutBox> | null = null
  for (const [id, box] of layout) if (box.rotation) (out ??= new Map(layout)).set(id, placedBox(box))
  return out ?? layout
}

/** The box of the item before it turns, from either layout: this is what the node's x, y and size say. */
export function ownBox(box: LayoutBox): LayoutBox {
  return box.own ?? box
}

/** The stored value of a rotation: −180..180, to 0.1 degrees, with no −0. */
export function normalRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const inRange = ((((degrees + 180) % 360) + 360) % 360) - 180
  return Math.round(inRange * 10) / 10 || 0
}

/** The degrees that a pointer turned about `center`, from `from` to `to`. */
export function turnAbout(center: Point, from: Point, to: Point): number {
  const angle = (point: Point): number => (Math.atan2(point[1] - center[1], point[0] - center[0]) * 180) / Math.PI
  return angle(to) - angle(from)
}

/** How much a corner scales from a fixed `anchor` when the pointer goes to `pointer`: along the box's diagonal, so the turn of the box has no effect. */
export function scaleFrom(anchor: Point, corner: Point, pointer: Point): number {
  const dx = corner[0] - anchor[0]
  const dy = corner[1] - anchor[1]
  const length = dx * dx + dy * dy
  return length > 0 ? ((pointer[0] - anchor[0]) * dx + (pointer[1] - anchor[1]) * dy) / length : 1
}

const HANDLE_ANGLE: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 }
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']

/** The nearest of the four resize cursors for a handle of a turned box. undefined: a handle with no resize cursor. */
export function handleCursor(handle: string, degrees: number): string | undefined {
  const angle = HANDLE_ANGLE[handle]
  if (angle === undefined) return undefined
  return RESIZE_CURSORS[Math.round((((angle + degrees) % 180) + 180) % 180 / 45) % RESIZE_CURSORS.length]
}
