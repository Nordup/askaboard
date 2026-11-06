/**
 * The board file format: `*.board.json` in the learning folder.
 *
 * Version 2: the board is one document of nodes (ink, shape, frame, text,
 * svg, image, live). The file must stay small in Git diffs, so the serializer writes one
 * node per line, rounds coordinates to 1 decimal and pressure to 2 decimals,
 * and keeps a fixed key order. Board coordinates are logical points, origin at
 * the centre, +y down. The camera is NOT stored here (see state.json).
 *
 * Version 1 files (ink strokes in "items") load as v2 ink nodes and save as v2.
 * Unknown node kinds, unknown node fields and unknown style keys survive a
 * load/save round trip untouched.
 *
 * This module has no DOM or Node imports: the main process and the renderer
 * both use it.
 */

import type { NodeFollows } from './world-links'

export const BOARD_FORMAT = 'learning-space.board'
export const BOARD_VERSION = 2
export const BOARD_SUFFIX = '.board.json'
/**
 * The version of the board's text layout: its fonts and their metrics (board/content.css, styles/hand.woff2).
 * A text measure is recorded with it (main/live-scene.ts answerHost), and a measure of another version is
 * measured again, so a scene never lays text out by sizes of a layout the board no longer has.
 * Raise it with every change of the board's fonts or their metrics.
 * 1: the system font (before 2026-11-03). 2: the hand font (B59), with ink-covering advances and line metrics.
 */
export const BOARD_LAYOUT = 2
/** New boards go to this folder, relative to the learning folder root. */
export const BOARDS_DIR = 'boards'

/** One ink sample: x, y (board points, relative to the node's x, y) and pressure (0..1). */
export type InkPoint = [x: number, y: number, pressure: number]

export type Author = 'learner' | 'agent'

/**
 * The style whitelist: CSS inline-style properties in camelCase, mapped 1:1 to
 * CSS. Values are CSS strings ("240px", "flex", "#222"). No margin, no grid,
 * no position or transform: the app owns positions (node x, y).
 */
/**
 * A CSS property name as a style key. Both forms work: kebab-case (as in a
 * style="" attribute; case-insensitive, like CSS) and camelCase (as in a
 * style object): "font-size", "Font-Size" and "fontSize" all give "fontSize".
 */
export function styleKey(name: string): string {
  const key = name.trim()
  return key.includes('-') ? key.toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : key
}

export const STYLE_KEYS = [
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'gap',
  'rowGap',
  'columnGap',
  'display',
  'flexDirection',
  'flexWrap',
  'alignItems',
  'alignContent',
  'justifyContent',
  'alignSelf',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'background',
  'backgroundColor',
  'color',
  'opacity',
  'borderRadius',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderColor',
  'borderWidth',
  'borderStyle',
  'boxShadow',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textDecoration',
  'textTransform',
  'whiteSpace',
  'overflow',
  'objectFit'
] as const

export type StyleKey = (typeof STYLE_KEYS)[number]
/** A node's style. Keys outside STYLE_KEYS are kept in the file but never rendered. */
export type NodeStyle = Partial<Record<StyleKey, string>> & Record<string, string>

const STYLE_KEY_SET: ReadonlySet<string> = new Set(STYLE_KEYS)
/** `display` values the content layer renders. */
const DISPLAY_VALUES = new Set(['flex', 'block', 'none'])

/** Only whitelisted keys with plain string values. For rendering. */
export function renderableStyle(style: NodeStyle | undefined): Partial<Record<StyleKey, string>> {
  const out: Partial<Record<StyleKey, string>> = {}
  if (!style) return out
  for (const [key, value] of Object.entries(style)) {
    if (!STYLE_KEY_SET.has(key) || typeof value !== 'string') continue
    // No external resources from a style value (url(...)), no expressions.
    if (/url\s*\(|expression\s*\(|javascript:/i.test(value)) continue
    if (key === 'display' && !DISPLAY_VALUES.has(value.trim())) continue
    out[key as StyleKey] = value
  }
  return out
}

interface NodeBase {
  id: string
  /** A label for agents and people (HTML layer-name). Optional. */
  name?: string
  /** The parent node (a frame), or none for a top-level node. */
  parent?: string
  /** Board points. Relative to the parent's padding box (the CSS containing block) when parented. */
  x: number
  y: number
  /** Order among siblings: higher draws later (on top). */
  z: number
  author: Author
  /** The board's sequence number when this node was created or last changed. */
  seq: number
  /** Locked nodes can be selected, but not moved, resized or deleted by hand. */
  locked?: boolean
  /** A link to a point of a world: the item moves with it (shared/world-links.ts). */
  follows?: NodeFollows
}

export interface InkNode extends NodeBase {
  kind: 'ink'
  tool: 'pen' | 'highlighter'
  color: string
  /** Nominal width in board points. Pen pressure scales it. */
  width: number
  points: InkPoint[]
}

export type ShapeKind = 'rect' | 'ellipse' | 'arrow' | 'line'
export type ShapeFill = 'none' | 'light' | 'solid'
export type ShapeLine = 'solid' | 'dashed' | 'dotted'
export type ShapeHeads = 'end' | 'both' | 'none'

export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'arrow', 'line']
const SHAPE_FILLS: readonly ShapeFill[] = ['none', 'light', 'solid']
const SHAPE_LINES: readonly ShapeLine[] = ['solid', 'dashed', 'dotted']
const SHAPE_HEADS: readonly ShapeHeads[] = ['end', 'both', 'none']

/**
 * A shape the learner drew with a shape tool (decision B71): it keeps its kind and its style, so it
 * stays editable, and the board paints it as ink strokes (renderer board/shapes.ts) made from these
 * fields and `seed`, so the same shape looks the same each time.
 * Rect and ellipse: x, y is the top-left of the box and w, h its size (not negative).
 * Arrow and line: x, y is the start and w, h the vector to the end (either may be negative).
 * `fill` counts for rect and ellipse, `heads` for an arrow; the other kinds keep them unused.
 * Like ink, a shape paints on the ink canvas and can belong to a frame or a world (parentKey).
 */
export interface ShapeNode extends NodeBase {
  kind: 'shape'
  shape: ShapeKind
  w: number
  h: number
  color: string
  /** Nominal stroke width in board points, as ink's. */
  width: number
  fill: ShapeFill
  line: ShapeLine
  heads: ShapeHeads
  /** The seed of the hand-drawn wobble (a 32-bit unsigned integer). */
  seed: number
}

/**
 * A box. Children: with `display: flex` the browser lays them out (their x, y
 * are ignored); otherwise each child is absolutely placed at its x, y.
 */
export interface FrameNode extends NodeBase {
  kind: 'frame'
  /**
   * A frame that hugs its children (a group's frame): its box is the bounds of what it holds, and the
   * board keeps it so as they change (renderer board/hug.ts). The value is the "width height" the board
   * last gave it; a style width or height that another hand set since ends the hug (hugsChildren).
   */
  hug?: string
  style: NodeStyle
}

/** A frame whose box the board derives from its children (FrameNode.hug): its size is still the one the board gave it, and its children are placed, not flowed. */
export function hugsChildren(node: BoardNode): node is FrameNode {
  if (node.kind !== 'frame') return false
  const frame = node as FrameNode
  return typeof frame.hug === 'string' && frame.style?.display !== 'flex' && frame.hug === `${frame.style?.width} ${frame.style?.height}`
}

/**
 * A group's frame saved before frames recorded their hug (before 2026-11-03): scenes made it with exactly
 * this style (renderer live/compile.ts). It hugs from now on, from the size it has.
 */
function withHug(node: BoardNode): BoardNode {
  if (node.kind !== 'frame' || node.author !== 'agent' || (node as FrameNode).hug !== undefined) return node
  const style = (node as FrameNode).style
  if (!isRecord(style)) return node
  const keys = Object.keys(style).sort().join(' ')
  const px = (value: unknown): boolean => typeof value === 'string' && /^\d+px$/.test(value)
  if (keys !== 'background height overflow width' || style.background !== 'transparent' || style.overflow !== 'visible' || !px(style.width) || !px(style.height)) return node
  return { ...node, hug: `${style.width} ${style.height}` } as FrameNode
}

/** Text with light inline markup: `**bold**`, `*italic*`, `$inline math$`. */
export interface TextNode extends NodeBase {
  kind: 'text'
  text: string
  /** Degrees, clockwise, about the centre of its box (−180..180). Absent means 0; 0 is never stored. x, y and the size are those of the box before it turns. */
  rotation?: number
  style: NodeStyle
}

/** A sanitized SVG drawing with a viewBox. Element ids inside are kept. */
export interface SvgNode extends NodeBase {
  kind: 'svg'
  markup: string
  style: NodeStyle
}

/** A picture file in the learning folder, e.g. `assets/earth.png`. */
export interface ImageNode extends NodeBase {
  kind: 'image'
  src: string
  style: NodeStyle
}

/**
 * A world: `code` runs on the board's world surface (renderer/src/live-pixels/world).
 * `params`: named values that scene playback may override. `w`, `h`: its nominal
 * size in board points. Ink drawn on it becomes its child, as on a frame.
 *
 * Boards from before worlds hold items with `mode` "shader", "canvas" or "program".
 * They load and keep all their data, and they run nothing (isOldLive).
 */
export interface LiveNode extends NodeBase {
  kind: 'live'
  /** Only on items of an older kind, and on worlds of early boards ("world"). */
  mode?: string
  code: string
  params: Record<string, number>
  /** Worlds: a JSON value for the code (world.data). */
  data?: unknown
  /** Worlds: marks kept on parts. An item with the same id follows the point `pin:<id>`. */
  pins?: Array<{ id: string; part: string; local: [number, number, number] }>
  w: number
  h: number
  /** Other look (opacity, border radius…). Its width and height are ignored: `w`, `h` set the size. */
  style: NodeStyle
  /**
   * Worlds a scene played: the scene clock they rest at after that
   * scene (its end time and its last step), so `scene.t` and `scene.step`
   * after a reload are what the learner last saw. Optional.
   */
  rest?: { t: number; step?: string }
}

/** A node of a kind this version does not know (or an invalid one). It survives load/save untouched. */
export interface ForeignNode {
  id: string
  kind: string
  seq: number
  [key: string]: unknown
}

export type KnownNode = InkNode | ShapeNode | FrameNode | TextNode | SvgNode | ImageNode | LiveNode
export type ContentNode = FrameNode | TextNode | SvgNode | ImageNode | LiveNode
/** The kinds the ink canvas paints: ink strokes and shapes. Every other known kind is content (DOM). */
export type PaintedNode = InkNode | ShapeNode
export type BoardNode = KnownNode | ForeignNode

export interface BoardDoc {
  /**
   * The board's id (newItemId('b')): its scene records are .learning-space/scenes/<id>.jsonl
   * (main/scene-store.ts). Made when the first scene record is written; a board with no scenes has none.
   * Older builds keep it as an unknown key (extra), so it survives their saves.
   */
  id?: string
  /** The next free sequence number. Always greater than every node's seq. */
  nextSeq: number
  /** File order (stable for diffs). Draw order comes from parent + z. */
  nodes: BoardNode[]
  /** Unknown top-level keys from the file, kept for the round trip. */
  extra: Record<string, unknown>
}

// ---------- Validation (cached per object) ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validStyle(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function validBase(node: Record<string, unknown>): boolean {
  return (
    finite(node.x) &&
    finite(node.y) &&
    finite(node.z) &&
    (node.parent === undefined || typeof node.parent === 'string') &&
    (node.name === undefined || typeof node.name === 'string') &&
    (node.author === 'learner' || node.author === 'agent')
  )
}

/** A node's rotation in degrees: 0 for the kinds that do not turn, and for a value that is not a number. */
export function nodeRotation(node: BoardNode): number {
  const rotation = (node as { rotation?: unknown }).rotation
  return node.kind === 'text' && typeof rotation === 'number' && Number.isFinite(rotation) ? rotation : 0
}

function validKnown(node: BoardNode): boolean {
  const raw = node as Record<string, unknown>
  if (!validBase(raw)) return false
  switch (node.kind) {
    case 'ink':
      return (
        (raw.tool === 'pen' || raw.tool === 'highlighter') &&
        typeof raw.color === 'string' &&
        finite(raw.width) &&
        Array.isArray(raw.points) &&
        raw.points.every((point) => Array.isArray(point) && finite(point[0]) && finite(point[1]) && finite(point[2]))
      )
    case 'shape':
      return (
        SHAPE_KINDS.includes(raw.shape as ShapeKind) &&
        finite(raw.w) &&
        finite(raw.h) &&
        typeof raw.color === 'string' &&
        finite(raw.width) &&
        SHAPE_FILLS.includes(raw.fill as ShapeFill) &&
        SHAPE_LINES.includes(raw.line as ShapeLine) &&
        SHAPE_HEADS.includes(raw.heads as ShapeHeads) &&
        finite(raw.seed)
      )
    case 'frame':
      return validStyle(raw.style)
    case 'text':
      return typeof raw.text === 'string' && validStyle(raw.style)
    case 'svg':
      return typeof raw.markup === 'string' && validStyle(raw.style)
    case 'image':
      return typeof raw.src === 'string' && validStyle(raw.style)
    case 'live':
      return (
        typeof raw.code === 'string' &&
        isRecord(raw.params) &&
        Object.values(raw.params).every(finite) &&
        finite(raw.w) &&
        finite(raw.h) &&
        validStyle(raw.style)
      )
    default:
      return false
  }
}

const validity = new WeakMap<object, boolean>()

/** True when the node is of a known kind and has every field that kind needs. */
export function isKnown(node: BoardNode): node is KnownNode {
  let ok = validity.get(node)
  if (ok === undefined) {
    ok = validKnown(node)
    validity.set(node, ok)
  }
  return ok
}

export function isInk(node: BoardNode): node is InkNode {
  return node.kind === 'ink' && isKnown(node)
}

export function isShape(node: BoardNode): node is ShapeNode {
  return node.kind === 'shape' && isKnown(node)
}

/** Ink or a shape: the ink canvas paints it, and it has no DOM element. */
export function isPainted(node: BoardNode): node is PaintedNode {
  return (node.kind === 'ink' || node.kind === 'shape') && isKnown(node)
}

export function isContent(node: BoardNode): node is ContentNode {
  return node.kind !== 'ink' && node.kind !== 'shape' && isKnown(node)
}

export function isFrame(node: BoardNode): node is FrameNode {
  return node.kind === 'frame' && isKnown(node)
}

/** An item of a kind that no longer runs: it keeps its data and shows a note. */
export function isOldLive(node: LiveNode): boolean {
  return node.mode !== undefined && node.mode !== 'world'
}

export function isLive(node: BoardNode): node is LiveNode {
  return node.kind === 'live' && isKnown(node)
}

/** A node that ink and shapes can belong to (decision B7): a frame or a world. */
export function isInkHost(node: BoardNode): node is FrameNode | LiveNode {
  return (node.kind === 'frame' || node.kind === 'live') && isKnown(node)
}

/** Map key for top-level nodes. */
export const ROOT = ''

/** The parent key of a node: its parent when that is a frame on the board (or a live item, for ink and shapes), else ROOT. */
export function parentKey(node: BoardNode, byId: ReadonlyMap<string, BoardNode>): string {
  const parent = typeof node.parent === 'string' ? byId.get(node.parent) : undefined
  if (!parent || parent.id === node.id) return ROOT
  return isFrame(parent) || (isInkHost(parent) && (node.kind === 'ink' || node.kind === 'shape')) ? parent.id : ROOT
}

/** A shape's kind in words, for agents and people: "rectangle", "ellipse", "arrow", "line". */
export const SHAPE_WORDS: Record<ShapeKind, string> = { rect: 'rectangle', ellipse: 'ellipse', arrow: 'arrow', line: 'line' }

/** The word for a node's kind in what agents read: its kind, or for a shape the shape's own word. */
export function kindWord(node: BoardNode): string {
  return isShape(node) ? SHAPE_WORDS[node.shape] : node.kind
}

export function emptyBoard(): BoardDoc {
  return { nextSeq: 1, nodes: [], extra: {} }
}

// ---------- Parse ----------

const KNOWN_TOP_KEYS = new Set(['format', 'version', 'id', 'nextSeq', 'nodes', 'items'])

/** A v1 stroke item becomes a v2 ink node: x = y = 0, the points stay absolute. */
function migrateV1Item(entry: Record<string, unknown>, index: number): Record<string, unknown> {
  if (entry.kind !== 'stroke') return entry
  const { id, kind: _kind, seq, tool, color, width, points, ...rest } = entry
  return { id, kind: 'ink', x: 0, y: 0, z: index + 1, author: 'learner', seq, tool, color, width, ...rest, points }
}

/** Parse board text (v1 or v2). Throws an Error with a readable message on bad input. */
export function parseBoard(text: string): BoardDoc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`The board file is not valid JSON (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (!isRecord(raw)) throw new Error('The board file does not contain a JSON object.')
  if (raw.format !== undefined && raw.format !== BOARD_FORMAT) {
    throw new Error(`The file format is "${String(raw.format)}", not "${BOARD_FORMAT}".`)
  }
  if (finite(raw.version) && raw.version > BOARD_VERSION) {
    throw new Error(`The board uses format version ${raw.version}. This app reads up to version ${BOARD_VERSION}.`)
  }
  const v1 = raw.nodes === undefined && raw.items !== undefined
  const source = v1 ? raw.items : raw.nodes === undefined ? [] : raw.nodes
  if (!Array.isArray(source)) throw new Error(`The "${v1 ? 'items' : 'nodes'}" field is not a list.`)

  const nodes: BoardNode[] = []
  let maxSeq = 0
  source.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.kind !== 'string') {
      throw new Error('A board node has no string "id" or "kind".')
    }
    const seq = finite(entry.seq) ? entry.seq : 0
    const migrated = v1 ? migrateV1Item(entry, index) : entry
    let node = withHug({ ...migrated, seq } as BoardNode)
    if (node.kind === 'ink' && isKnown(node)) {
      // Clamp pressure; an invalid ink node stays foreign data, so a save never destroys it.
      node = { ...node, points: node.points.map(([x, y, p]) => [x, y, Math.min(1, Math.max(0, p))] as InkPoint) }
    }
    nodes.push(node)
    maxSeq = Math.max(maxSeq, seq)
  })

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_TOP_KEYS.has(key)) extra[key] = value

  const nextSeq = Math.max(finite(raw.nextSeq) ? Math.floor(raw.nextSeq) : 1, maxSeq + 1)
  return { ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}), nextSeq, nodes, extra }
}

// ---------- Serialize ----------

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits
  const result = Math.round(value * factor) / factor
  return Object.is(result, -0) ? 0 : result
}

/** Fixed key order: common fields, kind fields, unknown fields, points last. */
const COMMON_KEYS = ['id', 'kind', 'name', 'parent', 'x', 'y', 'z', 'author', 'seq', 'locked'] as const
const KIND_KEYS: Record<string, readonly string[]> = {
  ink: ['tool', 'color', 'width'],
  shape: ['shape', 'w', 'h', 'color', 'width', 'fill', 'line', 'heads', 'seed'],
  frame: ['hug', 'style'],
  text: ['text', 'rotation', 'style'],
  svg: ['style', 'markup'],
  image: ['src', 'style'],
  live: ['mode', 'w', 'h', 'params', 'style', 'code']
}

export function serializeNode(node: BoardNode): string {
  if (!isKnown(node)) return JSON.stringify(node)
  const raw = node as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of COMMON_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    out[key] = key === 'x' || key === 'y' ? round(value as number, 1) : value
  }
  for (const key of KIND_KEYS[node.kind]) out[key] = key === 'width' ? round(raw[key] as number, 2) : key === 'w' || key === 'h' ? round(raw[key] as number, 1) : raw[key]
  for (const [key, value] of Object.entries(raw)) if (!(key in out) && key !== 'points') out[key] = value
  if (node.kind === 'ink') out.points = savedInkPoints(node.points)
  return JSON.stringify(out)
}

/**
 * Ink points at the precision of the board file (x, y to 0.1 board point,
 * pressure to 2 decimals). The save step and get_item's "points" use this one
 * function, so the points an agent reads are the points the file holds.
 */
export function savedInkPoints(points: readonly InkPoint[]): InkPoint[] {
  return points.map(([x, y, p]) => [round(x, 1), round(y, 1), round(p, 2)])
}

/**
 * Each node's line, by node object. Board nodes are immutable (a change makes a new
 * object), so an autosave serialises only the nodes that changed since the last save:
 * at 5,000 strokes a full serialise costs about 15-25 ms on the renderer thread.
 */
const nodeLines = new WeakMap<BoardNode, string>()

function nodeLine(node: BoardNode): string {
  let line = nodeLines.get(node)
  if (line === undefined) {
    line = serializeNode(node)
    nodeLines.set(node, line)
  }
  return line
}

/** Serialize with one node per line, so Git diffs stay small. */
export function serializeBoard(doc: BoardDoc): string {
  const lines = ['{', `  "format": ${JSON.stringify(BOARD_FORMAT)},`, `  "version": ${BOARD_VERSION},`, ...(doc.id ? [`  "id": ${JSON.stringify(doc.id)},`] : []), `  "nextSeq": ${doc.nextSeq},`]
  for (const [key, value] of Object.entries(doc.extra)) {
    if (!KNOWN_TOP_KEYS.has(key)) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  }
  if (doc.nodes.length === 0) {
    lines.push('  "nodes": []')
  } else {
    lines.push('  "nodes": [')
    doc.nodes.forEach((node, index) => {
      lines.push(`    ${nodeLine(node)}${index < doc.nodes.length - 1 ? ',' : ''}`)
    })
    lines.push('  ]')
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

// ---------- Change tracking ----------

/** A rectangle in board points. */
export interface BoardBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A node that left the board, with the seq of its removal. */
export interface Removal {
  node: BoardNode
  seq: number
  /** World bounds at the time of removal, when the renderer knew them. */
  bounds?: BoardBounds | null
  /** Who removed it ("learner" or "agent"), when the renderer knew it. */
  by?: Author
}

/**
 * A node that took a new seq: its state just before (null when it is new),
 * so the change can be told apart later (added, moved, resized, edited).
 */
export interface Revision {
  id: string
  /** The seq the node took. */
  seq: number
  before: BoardNode | null
  /** The node as the change left it. */
  after: BoardNode
  /** Who made the change ("learner" or "agent"), when known. */
  by?: Author
}

/**
 * Give a new seq to every node in `next` that is not in `previous`
 * (by object identity). Created, moved or restored nodes count as changed.
 * Every id in `previous` that is not in `next` is a removal: it also takes a
 * seq, so an agent's change cursor sees erasing as a change.
 */
export function stampChanged(
  previous: readonly BoardNode[],
  next: readonly BoardNode[],
  nextSeq: number
): { nodes: BoardNode[]; nextSeq: number; removed: Removal[]; revisions: Revision[] } {
  const known = new Set(previous)
  const prior = new Map(previous.map((node) => [node.id, node]))
  let seq = nextSeq
  const revisions: Revision[] = []
  const nodes = next.map((node) => {
    if (known.has(node)) return node
    const after = { ...node, seq: seq++ }
    revisions.push({ id: node.id, seq: after.seq, before: prior.get(node.id) ?? null, after })
    return after
  })
  const kept = new Set(next.map((node) => node.id))
  const removed: Removal[] = []
  for (const node of previous) if (!kept.has(node.id)) removed.push({ node, seq: seq++ })
  return { nodes, nextSeq: seq, removed, revisions }
}

/**
 * Compare a board with a new version of it from disk (Git, an agent, another
 * editor). Nodes that are new or different by content get a fresh seq; ids
 * that are gone are removals. Nodes equal by content keep their old object,
 * so the result has the same seqs as before for unchanged nodes.
 */
export function reconcileBoard(previous: BoardDoc, incoming: BoardDoc): { doc: BoardDoc; removed: Removal[]; revisions: Revision[] } {
  const before = new Map(previous.nodes.map((node) => [node.id, node]))
  const contentKey = (node: BoardNode): string => serializeNode({ ...node, seq: 0 })
  let seq = Math.max(previous.nextSeq, incoming.nextSeq)
  const revisions: Revision[] = []
  const nodes = incoming.nodes.map((node) => {
    const old = before.get(node.id)
    if (old && contentKey(old) === contentKey(node)) return old
    const after = { ...node, seq: seq++ }
    revisions.push({ id: node.id, seq: after.seq, before: old ?? null, after })
    return after
  })
  const kept = new Set(incoming.nodes.map((node) => node.id))
  const removed: Removal[] = []
  for (const node of previous.nodes) if (!kept.has(node.id)) removed.push({ node, seq: seq++ })
  return { doc: { ...(incoming.id ? { id: incoming.id } : {}), nextSeq: seq, nodes, extra: incoming.extra }, removed, revisions }
}

/** An item's own opacity as a number. The one conversion: the board, the world surface and the screenshot read it here, so 0 stays 0 in all three. */
export function nodeOpacity(node: { style?: { opacity?: unknown } } | undefined): number {
  const raw = node?.style?.opacity
  if (raw === undefined || raw === null || raw === '') return 1
  const value = Number(raw)
  return Number.isFinite(value) ? value : 1
}

/** A short random node id, for example `s_k3j2x9qa`. */
export function newItemId(prefix = 's'): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let id = `${prefix}_`
  for (const byte of bytes) id += alphabet[byte % alphabet.length]
  return id
}

/** The display name of a board: the file name without `.board.json`. */
export function boardName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return base.endsWith(BOARD_SUFFIX) ? base.slice(0, -BOARD_SUFFIX.length) : base
}

/** File-name-safe board name: no separators, no control characters, no leading dots. Main names a new or renamed board with it; the search panel shows the name it will get. */
export function sanitizeBoardName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
}

export function isBoardPath(relPath: string): boolean {
  return relPath.endsWith(BOARD_SUFFIX)
}
