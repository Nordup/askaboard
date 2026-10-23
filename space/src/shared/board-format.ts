/**
 * The board file format: `*.board.json` in the learning folder.
 *
 * The file must stay small in Git diffs, so the serializer writes one item per
 * line, rounds coordinates to 1 decimal and pressure to 2 decimals, and keeps
 * a fixed key order. Board coordinates are logical points, origin at the
 * centre, +y down. The camera is NOT stored here (see state.json).
 *
 * This module has no DOM or Node imports: the main process and the renderer
 * both use it.
 */

export const BOARD_FORMAT = 'learning-space.board'
export const BOARD_VERSION = 1
export const BOARD_SUFFIX = '.board.json'
/** New boards go to this folder, relative to the learning folder root. */
export const BOARDS_DIR = 'boards'

/** One ink sample: x, y (board points) and pressure (0..1). */
export type InkPoint = [x: number, y: number, pressure: number]

export interface StrokeItem {
  id: string
  kind: 'stroke'
  /** The board's sequence number when this item was created or last changed. */
  seq: number
  tool: 'pen' | 'highlighter'
  color: string
  /** Nominal width in board points. Pen pressure scales it. */
  width: number
  points: InkPoint[]
}

/** An item of a kind this version does not know. It survives load/save untouched. */
export interface ForeignItem {
  id: string
  kind: string
  seq: number
  [key: string]: unknown
}

export type BoardItem = StrokeItem | ForeignItem

export interface BoardDoc {
  /** The next free sequence number. Always greater than every item's seq. */
  nextSeq: number
  items: BoardItem[]
  /** Unknown top-level keys from the file, kept for the round trip. */
  extra: Record<string, unknown>
}

export function isStroke(item: BoardItem): item is StrokeItem {
  return item.kind === 'stroke'
}

export function emptyBoard(): BoardDoc {
  return { nextSeq: 1, items: [], extra: {} }
}

const KNOWN_TOP_KEYS = new Set(['format', 'version', 'nextSeq', 'items'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Read a stroke, or return null when the item is not a valid stroke. */
function readStroke(raw: Record<string, unknown>): StrokeItem | null {
  if (raw.tool !== 'pen' && raw.tool !== 'highlighter') return null
  if (typeof raw.color !== 'string' || !finite(raw.width) || !Array.isArray(raw.points)) return null
  const points: InkPoint[] = []
  for (const point of raw.points) {
    if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return null
    points.push([point[0], point[1], finite(point[2]) ? Math.min(1, Math.max(0, point[2])) : 0.5])
  }
  return { ...(raw as object), points } as StrokeItem
}

/** Parse board text. Throws an Error with a readable message on bad input. */
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
    throw new Error(`The board uses format version ${raw.version}. This app reads version ${BOARD_VERSION}.`)
  }
  const sourceItems = raw.items === undefined ? [] : raw.items
  if (!Array.isArray(sourceItems)) throw new Error('The "items" field is not a list.')

  const items: BoardItem[] = []
  let maxSeq = 0
  for (const entry of sourceItems) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.kind !== 'string') {
      throw new Error('A board item has no string "id" or "kind".')
    }
    const seq = finite(entry.seq) ? entry.seq : 0
    const base = { ...entry, seq }
    // An invalid stroke is kept as foreign data, so a save never destroys it.
    const item: BoardItem = entry.kind === 'stroke' ? (readStroke(base) ?? (base as ForeignItem)) : (base as ForeignItem)
    items.push(item)
    maxSeq = Math.max(maxSeq, seq)
  }

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_TOP_KEYS.has(key)) extra[key] = value

  const nextSeq = Math.max(finite(raw.nextSeq) ? Math.floor(raw.nextSeq) : 1, maxSeq + 1)
  return { nextSeq, items, extra }
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits
  const result = Math.round(value * factor) / factor
  return Object.is(result, -0) ? 0 : result
}

function serializeItem(item: BoardItem): string {
  if (!isStroke(item)) return JSON.stringify(item)
  const { id, kind, seq, tool, color, width, points, ...rest } = item
  return JSON.stringify({
    id,
    kind,
    seq,
    tool,
    color,
    width: round(width, 2),
    ...rest,
    points: points.map(([x, y, p]) => [round(x, 1), round(y, 1), round(p, 2)])
  })
}

/** Serialize with one item per line, so Git diffs stay small. */
export function serializeBoard(doc: BoardDoc): string {
  const lines = [
    '{',
    `  "format": ${JSON.stringify(BOARD_FORMAT)},`,
    `  "version": ${BOARD_VERSION},`,
    `  "nextSeq": ${doc.nextSeq},`
  ]
  for (const [key, value] of Object.entries(doc.extra)) {
    if (!KNOWN_TOP_KEYS.has(key)) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  }
  if (doc.items.length === 0) {
    lines.push('  "items": []')
  } else {
    lines.push('  "items": [')
    doc.items.forEach((item, index) => {
      lines.push(`    ${serializeItem(item)}${index < doc.items.length - 1 ? ',' : ''}`)
    })
    lines.push('  ]')
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/** An item that left the board, with the seq of its removal. */
export interface Removal {
  item: BoardItem
  seq: number
}

/**
 * Give a new seq to every item in `next` that is not in `previous`
 * (by object identity). Created, moved or restored items count as changed.
 * Every id in `previous` that is not in `next` is a removal: it also takes a
 * seq, so an agent's change cursor sees erasing as a change.
 */
export function stampChanged(
  previous: readonly BoardItem[],
  next: readonly BoardItem[],
  nextSeq: number
): { items: BoardItem[]; nextSeq: number; removed: Removal[] } {
  const known = new Set(previous)
  let seq = nextSeq
  const items = next.map((item) => (known.has(item) ? item : { ...item, seq: seq++ }))
  const kept = new Set(next.map((item) => item.id))
  const removed: Removal[] = []
  for (const item of previous) if (!kept.has(item.id)) removed.push({ item, seq: seq++ })
  return { items, nextSeq: seq, removed }
}

/**
 * Compare a board with a new version of it from disk (Git, an agent, another
 * editor). Items that are new or different by content get a fresh seq; ids
 * that are gone are removals. Items equal by content keep their old object,
 * so the result has the same seqs as before for unchanged ink.
 */
export function reconcileBoard(previous: BoardDoc, incoming: BoardDoc): { doc: BoardDoc; removed: Removal[] } {
  const before = new Map(previous.items.map((item) => [item.id, item]))
  const contentKey = (item: BoardItem): string => serializeItem({ ...item, seq: 0 })
  let seq = Math.max(previous.nextSeq, incoming.nextSeq)
  const items = incoming.items.map((item) => {
    const old = before.get(item.id)
    if (old && contentKey(old) === contentKey(item)) return old
    return { ...item, seq: seq++ }
  })
  const kept = new Set(incoming.items.map((item) => item.id))
  const removed: Removal[] = []
  for (const item of previous.items) if (!kept.has(item.id)) removed.push({ item, seq: seq++ })
  return { doc: { nextSeq: seq, items, extra: incoming.extra }, removed }
}

/** A short random item id, for example `s_k3j2x9qa`. */
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

export function isBoardPath(relPath: string): boolean {
  return relPath.endsWith(BOARD_SUFFIX)
}
