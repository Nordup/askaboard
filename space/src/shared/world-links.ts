/**
 * Links from board items to points of a world (one-world-architecture.md,
 * section 5). A scene runs ahead of time, so it cannot know where a world's
 * point will be. An item stores the link, and the page moves the item with
 * each picture of the world. The same functions place a preview's items from
 * the points of a still.
 */

export type LinkPoint = [number, number]

/** The places of a world's published points now, by node id and name: board x, board y, visible. */
export type WorldPoints = Record<string, Record<string, [number, number, boolean]>>

/** A link to a point. The point plus offset is the item's shift from its place on the board. */
export interface PointLink {
  world: string
  point: string
  offset: LinkPoint
}

/**
 * A line or an arrow with an end on a point. Each end is fixed (a board point)
 * or a link, whose offset is added to the point.
 */
export interface PathFollows {
  ends: [PointLink | LinkPoint, PointLink | LinkPoint]
  /** The ends as the node's path has them. */
  at: [LinkPoint, LinkPoint]
  /** Arrows: the length of the head. */
  head?: number
  /** The node's x and y when its path was made: an item moved since then keeps its link on the point. */
  origin: LinkPoint
}

export type NodeFollows = PointLink | PathFollows

export type LinkMatrix = [number, number, number, number, number, number]

/** How a linked item shows now. */
export interface LinkLook {
  matrix?: LinkMatrix
  /** Svg paths: the path now. */
  d?: string
  /** Svg paths: the ends now, in board points. */
  ends?: [LinkPoint, LinkPoint]
  /** False while a point it follows is not visible. */
  visible: boolean
}

export interface LinkedNode {
  id: string
  kind: string
  x: number
  y: number
  follows?: NodeFollows
}

export function isPathFollows(follows: NodeFollows): follows is PathFollows {
  return 'ends' in follows
}

const isLink = (end: PointLink | LinkPoint): end is PointLink => !Array.isArray(end)

/** The place of a linked point now, or null when the world has not published it. */
export function pointNow(points: WorldPoints, world: string, point: string): [number, number, boolean] | null {
  return points[world]?.[point] ?? null
}

const f2 = (value: number): number => Math.round(value * 100) / 100

/** The path of a line, or with a head of an arrow, as live-prelude.js makes it. */
function pathOf(a: LinkPoint, b: LinkPoint, head: number | undefined): string {
  const line = `M${f2(a[0])} ${f2(a[1])} L${f2(b[0])} ${f2(b[1])}`
  if (head === undefined) return line
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const ux = (b[0] - a[0]) / length
  const uy = (b[1] - a[1]) / length
  const wing = (angle: number): LinkPoint => {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return [b[0] - head * (ux * c - uy * s), b[1] - head * (uy * c + ux * s)]
  }
  const p = wing(0.45)
  const q = wing(-0.45)
  return `${line} M${f2(p[0])} ${f2(p[1])} L${f2(b[0])} ${f2(b[1])} L${f2(q[0])} ${f2(q[1])}`
}

/** The rotation, scale and shift that take the segment from a0, b0 to a1, b1. */
function segmentMatrix(a0: LinkPoint, b0: LinkPoint, a1: LinkPoint, b1: LinkPoint): LinkMatrix {
  const ux = b0[0] - a0[0]
  const uy = b0[1] - a0[1]
  const vx = b1[0] - a1[0]
  const vy = b1[1] - a1[1]
  const n = ux * ux + uy * uy || 1
  const c = (ux * vx + uy * vy) / n
  const s = (ux * vy - uy * vx) / n
  return [c, s, -s, c, a1[0] - (c * a0[0] - s * a0[1]), a1[1] - (s * a0[0] + c * a0[1])]
}

/** The look of a linked node now, from the points of a picture or a still; null when no point it follows is known. */
export function linkLook(node: LinkedNode, points: WorldPoints): LinkLook | null {
  const follows = node.follows
  if (!follows) return null
  if (!isPathFollows(follows)) {
    const p = pointNow(points, follows.world, follows.point)
    if (!p) return null
    return { matrix: [1, 0, 0, 1, p[0] + follows.offset[0], p[1] + follows.offset[1]], visible: p[2] }
  }
  // An item moved by hand carries its fixed ends along; its linked ends stay on their points.
  const moved: LinkPoint = [node.x - follows.origin[0], node.y - follows.origin[1]]
  let visible = true
  let known = false
  const svg = node.kind === 'svg'
  const ends = follows.ends.map((end, k): LinkPoint => {
    const rest = follows.at[k]
    if (!isLink(end)) return svg ? rest : [rest[0] + moved[0], rest[1] + moved[1]]
    const p = pointNow(points, end.world, end.point)
    if (!p) return svg ? rest : [rest[0] + moved[0], rest[1] + moved[1]]
    known = true
    visible &&= p[2]
    const x = p[0] + end.offset[0]
    const y = p[1] + end.offset[1]
    return svg ? [x - moved[0], y - moved[1]] : [x, y]
  }) as [LinkPoint, LinkPoint]
  if (!known) return null
  if (svg) return { d: pathOf(ends[0], ends[1], follows.head), ends: [[ends[0][0] + moved[0], ends[0][1] + moved[1]], [ends[1][0] + moved[0], ends[1][1] + moved[1]]], visible }
  const a: LinkPoint = [follows.at[0][0] + moved[0], follows.at[0][1] + moved[1]]
  const b: LinkPoint = [follows.at[1][0] + moved[0], follows.at[1][1] + moved[1]]
  return { matrix: segmentMatrix(a, b, ends[0], ends[1]), visible }
}

/** The room around a linked path, for its box. */
const PATH_PAD = 4

/** A layout box at the place a link shows it. A plain shift moves its child origin too, so hit tests find its ink there. */
export function linkedBox<T extends { x: number; y: number; width: number; height: number; ox: number; oy: number }>(box: T, look: LinkLook): T {
  if (look.ends) {
    const [a, b] = look.ends
    const x = Math.min(a[0], b[0]) - PATH_PAD
    const y = Math.min(a[1], b[1]) - PATH_PAD
    return { ...box, x, y, width: Math.abs(a[0] - b[0]) + PATH_PAD * 2, height: Math.abs(a[1] - b[1]) + PATH_PAD * 2 }
  }
  const m = look.matrix
  if (!m) return box
  const xs = [box.x, box.x + box.width].flatMap((x) => [m[0] * x + m[2] * box.y + m[4], m[0] * x + m[2] * (box.y + box.height) + m[4]])
  const ys = [box.x, box.x + box.width].flatMap((x) => [m[1] * x + m[3] * box.y + m[5], m[1] * x + m[3] * (box.y + box.height) + m[5]])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const shift = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1
  return { ...box, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, ...(shift ? { ox: box.ox + m[4], oy: box.oy + m[5] } : {}) }
}

function multiply(a: LinkMatrix, b: LinkMatrix): LinkMatrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}

/** A playback look with a link on top: the link moves what the scene shows. `alpha`: the link's own fade. */
export function withLink<T extends { matrix?: LinkMatrix; opacity?: number; d?: string }>(base: T | undefined, look: LinkLook, alpha: number): T {
  const out = { ...(base ?? {}) } as T
  if (look.matrix) out.matrix = base?.matrix ? multiply(look.matrix, base.matrix) : look.matrix
  if (look.d !== undefined) out.d = look.d
  if (alpha < 1) out.opacity = (base?.opacity ?? 1) * alpha
  return out
}

/** A look that links can change. */
export type Linkable = { matrix?: LinkMatrix; opacity?: number; d?: string }

/** The overrides of a moment with the linked items placed from `points` (a preview's frame, a screenshot). */
export function linkedOverrides<T extends Linkable>(nodes: readonly LinkedNode[], overrides: ReadonlyArray<[string, T]>, points: WorldPoints): Array<[string, T]> {
  const out = new Map(overrides)
  for (const node of nodes) {
    const look = node.follows ? linkLook(node, points) : null
    if (look) out.set(node.id, withLink(out.get(node.id), look, look.visible ? 1 : 0))
  }
  return [...out]
}

/** A pointer tip that follows a point. */
export interface TipLink {
  point: [number, number]
  alpha?: number
  /** The points in the tip's place now: `at` stands in for each, and `share` of it is in `point`. A later glide leaves less of it there. */
  follows?: Array<{ world: string; point: string; at: [number, number]; share: number }>
}

/** A tip on points of worlds: `point` was made from their anchors, and each anchor gives way to the point's place now. */
export function linkedTip<T extends TipLink>(tip: T, points: WorldPoints): T {
  if (!tip.follows?.length) return tip
  let [x, y] = tip.point
  let main = 0
  let alpha = tip.alpha
  for (const link of tip.follows) {
    const p = pointNow(points, link.world, link.point)
    if (!p) continue
    x += link.share * (p[0] - link.at[0])
    y += link.share * (p[1] - link.at[1])
    if (link.share > main) {
      main = link.share
      alpha = p[2] ? tip.alpha : 0
    }
  }
  return { ...tip, point: [x, y], alpha }
}

/** A link after its world's node took another id. */
export function renamedFollows(follows: NodeFollows, rename: (id: string) => string): NodeFollows {
  const link = (e: PointLink): PointLink => ({ ...e, world: rename(e.world), point: e.point.startsWith('pin:') ? `pin:${rename(e.point.slice(4))}` : e.point })
  if (!isPathFollows(follows)) return link(follows)
  const end = (e: PointLink | LinkPoint): PointLink | LinkPoint => (isLink(e) ? link(e) : e)
  return { ...follows, ends: [end(follows.ends[0]), end(follows.ends[1])] }
}

/** The worlds that a link reads. */
export function followedWorlds(follows: NodeFollows): string[] {
  if (!isPathFollows(follows)) return [follows.world]
  return follows.ends.filter(isLink).map((end) => end.world)
}

/**
 * Copies of nodes under new ids (`idMap`: old id to new id): their links and
 * pins go with them. A link to a world that was not copied stays on that
 * world, except a pin: a pin is one mark's, so a copy of the mark alone is plain ink.
 */
export function copiedLinks<T>(nodes: T[], idMap: ReadonlyMap<string, string>): T[] {
  const rename = (id: string): string => idMap.get(id) ?? id
  return nodes.map((item) => {
    const node = item as { follows?: NodeFollows; pins?: Array<{ id: string }> }
    const out = { ...node }
    if (node.pins) out.pins = node.pins.filter((pin) => idMap.has(pin.id)).map((pin) => ({ ...pin, id: rename(pin.id) }))
    if (node.follows) {
      if (!isPathFollows(node.follows) && node.follows.point.startsWith('pin:') && !idMap.has(node.follows.world)) delete out.follows
      else out.follows = renamedFollows(node.follows, rename)
    }
    return out as T
  })
}

/** The world that a link follows, from a list of nodes. */
export function worldOf<T extends { id: string }>(nodes: readonly T[], follows: NodeFollows | undefined): (T & { name?: string; pins?: Array<{ id: string; part: string }> }) | undefined {
  return follows && !isPathFollows(follows) ? nodes.find((node) => node.id === follows.world) : undefined
}

/** The words of a mark on a part, for agents: `marked part "receptor" of world wave`; null when the node is no mark. */
export function markText(follows: NodeFollows | undefined, world: { id: string; name?: string; pins?: Array<{ id: string; part: string }> } | undefined): string | null {
  if (!follows || isPathFollows(follows) || !follows.point.startsWith('pin:') || !world) return null
  const pin = world.pins?.find((entry) => `pin:${entry.id}` === follows.point)
  return pin ? `marked part "${pin.part}" of world ${world.name ?? world.id}` : null
}

/** A one-line text of a link, for agents: "n_ab.charge". */
export function followsText(follows: NodeFollows): string {
  const text = (end: PointLink): string => `${end.world}.${end.point}`
  if (!isPathFollows(follows)) return text(follows)
  return follows.ends.map((end) => (isLink(end) ? text(end) : `${end[0]},${end[1]}`)).join(' to ')
}
