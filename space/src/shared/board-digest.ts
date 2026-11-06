import { isInk, isKnown, parentKey, ROOT, type BoardNode } from './board-format'

/**
 * The board model that needs no layout, shared by main and the renderer, so
 * that every tool gives the same answer to the same question: what counts as
 * an item, the texts of an item and the search over them, clustering by place,
 * and the words for places, counts and times. list_boards and open_board
 * (main/boards.ts) read a closed board from its parsed file; list_items and the
 * other reads (renderer/agent/reads.ts) add what needs the live layout.
 * Handwriting is ink, not text: it is counted, never searched.
 */

export interface BoardDigest {
  /** The learner's ink strokes (closed boards are not grouped into ink groups: that needs the layout). */
  learnerStrokes: number
  /** Items by the agent that are not ink. */
  agentItems: number
  /** The agent's ink strokes. */
  agentStrokes: number
  /** Distinct node.scene values. */
  scenes: number
  /** Items by the learner that are not ink, orphans and unknown kinds. */
  other: number
  /** The first heading or text of the agent's material, if any. */
  title: string | null
}

/** One piece of text a node holds: its name, its text, the text of an SVG, an image file, a program's code, or a string of an unknown kind. */
export interface TextField {
  field: 'name' | 'text' | 'svg text' | 'image' | 'code' | string
  text: string
}

export interface TextEntry {
  id: string
  kind: string
  name?: string
  /** The frame it sits in, when it has one. */
  parent?: string
  fields: TextField[]
}

export interface TextMatch {
  id: string
  kind: string
  name?: string
  parent?: string
  field: string
  /** The words around the match. */
  context: string
}

type Rect = { x: number; y: number; width: number; height: number }

// ---------- Words ----------

export const num = (value: number): string => Math.round(value).toLocaleString('en-US')
export const plural = (count: number, word: string, many = `${word}s`): string => `${num(count)} ${count === 1 ? word : many}`
export const q = (value: string): string => JSON.stringify(value)

/** "40 s ago", "5 min ago", "3 h ago"; a date after 48 hours. */
export function ago(ms: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - ms) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return new Date(ms).toISOString().slice(0, 10)
}

/** A short age for a list (the sidebar's boards): "now" under a minute, then "5m", "3h", "2d", "3w", "4mo", "1y" (whole units, rounded down). */
export function shortAgo(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

// ---------- Places ----------

/** A rect in whole board points: each edge rounded, the size from the rounded edges. Every place and every region argument use it, so they agree. */
export function wholeRect(region: Rect): Rect {
  const x = Math.round(region.x)
  const y = Math.round(region.y)
  return { x, y, width: Math.max(1, Math.round(region.x + region.width) - x), height: Math.max(1, Math.round(region.y + region.height) - y) }
}

/** "x,y w×h" in whole board points. */
export function placeText(region: Rect | null): string {
  if (!region) return '(no layout)'
  const r = wholeRect(region)
  return `${r.x},${r.y} ${r.width}×${r.height}`
}

export function unionRegions(regions: ReadonlyArray<Rect | null | undefined>): Rect | null {
  const valid = regions.filter((r): r is Rect => !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width >= 0 && r.height >= 0)
  if (!valid.length) return null
  const x = Math.min(...valid.map((r) => r.x))
  const y = Math.min(...valid.map((r) => r.y))
  return { x, y, width: Math.max(...valid.map((r) => r.x + r.width)) - x, height: Math.max(...valid.map((r) => r.y + r.height)) - y }
}

/** Where `a` is relative to `b` ("on", "right of", "below and left of"), and the gap between them (0 when they touch or overlap). */
export function relation(a: Rect, b: Rect): { gap: number; side: string } {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0)
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0)
  if (gapX === 0 && gapY === 0) return { gap: 0, side: 'on' }
  const horizontal = a.x >= b.x + b.width ? 'right of' : a.x + a.width <= b.x ? 'left of' : ''
  const vertical = a.y >= b.y + b.height ? 'below' : a.y + a.height <= b.y ? 'above' : ''
  return { gap: Math.hypot(gapX, gapY), side: horizontal && vertical ? `${vertical} and ${horizontal}` : horizontal || vertical }
}

/** Entries clustered by place: boxes closer than `gap` board points join one cluster. Clusters and their entries keep the input order. */
export function clusterByPlace<T>(entries: readonly T[], boundsOf: (entry: T) => Rect | null, gap: number): T[][] {
  const parent = entries.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const boxes = entries.map(boundsOf)
  for (let i = 0; i < entries.length; i++) {
    const a = boxes[i]
    if (!a) continue
    for (let j = i + 1; j < entries.length; j++) {
      const b = boxes[j]
      if (b && a.x - gap <= b.x + b.width && b.x - gap <= a.x + a.width && a.y - gap <= b.y + b.height && b.y - gap <= a.y + a.height) parent[find(j)] = find(i)
    }
  }
  const out = new Map<number, T[]>()
  entries.forEach((entry, i) => out.set(find(i), [...(out.get(find(i)) ?? []), entry]))
  return [...out.values()]
}

// ---------- Items ----------

export const nameOf = (node: BoardNode): string | undefined => (typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined)
export const authorOf = (node: BoardNode): 'agent' | 'learner' => ((node as { author?: unknown }).author === 'agent' ? 'agent' : 'learner')
export const sceneIdOf = (node: BoardNode): string | undefined => {
  const scene = (node as { scene?: unknown }).scene
  return typeof scene === 'string' && scene ? scene : undefined
}
const parentOf = (node: BoardNode): string | undefined => (typeof (node as { parent?: unknown }).parent === 'string' ? ((node as { parent: string }).parent || undefined) : undefined)

/**
 * Whether a node that is not ink is an item of its own: top level, or made by
 * another author or another scene than its frame (children an html() root
 * holds carry no scene of their own). list_items and list_boards count these.
 */
export function isItem(node: BoardNode, byId: ReadonlyMap<string, BoardNode>): boolean {
  const key = isKnown(node) ? parentKey(node, byId) : ROOT
  const frame = key === ROOT ? undefined : byId.get(key)
  if (!frame) return true
  const scene = sceneIdOf(node)
  return authorOf(frame) !== authorOf(node) || (!!scene && scene !== sceneIdOf(frame))
}

/** Its parent id names no node. */
export const isOrphan = (node: BoardNode, byId: ReadonlyMap<string, BoardNode>): boolean => isKnown(node) && !!parentOf(node) && !byId.has(parentOf(node) as string)

// ---------- Texts ----------

/** A text as words: markup tags and the stars of bold and italic out, spaces collapsed. Maths stays as written. */
const plain = (raw: string): string => raw.replace(/<[^>]*>/g, ' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim()

/** The text a node shows: a text node's text, or the <text> elements of an SVG. */
export function shownText(node: BoardNode): string {
  const raw = node as unknown as Record<string, unknown>
  if (node.kind === 'text' && typeof raw.text === 'string') return plain(raw.text)
  if (node.kind === 'svg' && typeof raw.markup === 'string') return plain([...raw.markup.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1].replace(/<[^>]*>/g, '')).join(' '))
  return ''
}

/** The first words of a text, at most `max` characters. */
export function firstWords(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Every piece of text a node holds, in the order a search reads them (ink holds none). */
export function itemTexts(node: BoardNode): TextField[] {
  if (isInk(node)) return []
  const fields: TextField[] = []
  const name = nameOf(node)
  if (name) fields.push({ field: 'name', text: name })
  const raw = node as unknown as Record<string, unknown>
  if (!isKnown(node)) {
    // A kind this app does not know: every string it stores.
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' && !['id', 'kind', 'name', 'parent', 'author', 'scene'].includes(key)) fields.push({ field: key, text: value })
    return fields
  }
  const shown = shownText(node)
  if (shown) fields.push({ field: node.kind === 'svg' ? 'svg text' : 'text', text: shown })
  else if (node.kind === 'image' && typeof raw.src === 'string' && !raw.src.startsWith('data:')) fields.push({ field: 'image', text: raw.src })
  else if (node.kind === 'live' && typeof raw.code === 'string') fields.push({ field: 'code', text: raw.code })
  return fields
}

/** Every piece of text the board holds, per node. */
export function boardTexts(nodes: readonly BoardNode[]): TextEntry[] {
  const out: TextEntry[] = []
  for (const node of nodes) {
    const fields = itemTexts(node)
    if (!fields.length) continue
    const name = nameOf(node)
    const parent = parentOf(node)
    out.push({ id: node.id, kind: node.kind, ...(name ? { name } : {}), ...(parent ? { parent } : {}), fields })
  }
  return out
}

export function contextOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30)
  const end = Math.min(text.length, at + length + 30)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

/** Case-insensitive: the first field that holds the needle (lower case, trimmed), with the words around it. */
export function matchText(fields: readonly TextField[], needle: string): { field: string; context: string } | null {
  for (const { field, text } of fields) {
    const at = text.toLowerCase().indexOf(needle)
    if (at >= 0) return { field, context: contextOf(text, at, needle.length) }
  }
  return null
}

/** A match in words: the field (but for text and SVG text) and the words around it. */
export function matchWords(match: { field: string; context: string }): string {
  return `${match.field === 'text' || match.field === 'svg text' ? '' : `${match.field} `}“${match.context}”`
}

/** Case-insensitive search: one match per node, in its first field that holds the text. */
export function searchTexts(entries: readonly TextEntry[], query: string): TextMatch[] {
  const needle = query.toLowerCase().trim()
  if (!needle) return []
  const out: TextMatch[] = []
  for (const entry of entries) {
    const hit = matchText(entry.fields, needle)
    if (hit) out.push({ id: entry.id, kind: entry.kind, ...(entry.name ? { name: entry.name } : {}), ...(entry.parent ? { parent: entry.parent } : {}), ...hit })
  }
  return out
}

// ---------- A board without its layout ----------

/** The font size of a text node in points, when its style sets one. */
function fontSize(node: BoardNode): number {
  const style = (node as { style?: Record<string, unknown> }).style
  const raw = style ? (style.fontSize ?? style['font-size']) : undefined
  const value = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(value) ? value : 0
}

export function digestBoard(nodes: readonly BoardNode[]): BoardDigest {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const scenes = new Set<string>()
  let learnerStrokes = 0
  let agentStrokes = 0
  let agentItems = 0
  let other = 0
  let heading: { size: number; seq: number; text: string } | null = null
  let firstFrame: { seq: number; text: string } | null = null
  for (const node of nodes) {
    const scene = sceneIdOf(node)
    if (scene) scenes.add(scene)
    const agent = authorOf(node) === 'agent'
    if (isInk(node)) {
      if (agent) agentStrokes++
      else learnerStrokes++
      continue
    }
    if (isItem(node, byId)) {
      if (agent && isKnown(node) && !isOrphan(node, byId)) agentItems++
      else other++
    }
    if (!agent) continue
    if (node.kind === 'text') {
      const text = shownText(node)
      if ((text.match(/\p{L}/gu) ?? []).length < 3) continue
      const size = fontSize(node)
      if (!heading || size > heading.size || (size === heading.size && node.seq < heading.seq)) heading = { size, seq: node.seq, text }
    } else if (node.kind === 'frame' && !parentOf(node) && nameOf(node)) {
      if (!firstFrame || node.seq < firstFrame.seq) firstFrame = { seq: node.seq, text: nameOf(node) as string }
    }
  }
  const words = heading?.text ?? firstFrame?.text ?? null
  return { learnerStrokes, agentItems, agentStrokes, scenes: scenes.size, other, title: words ? firstWords(words, 60) : null }
}

/** The saved top-left corner of each node on the board: its x, y plus those of its frames (a flex frame's children are placed by layout, so these can be off for them). */
export function savedCorners(nodes: readonly BoardNode[]): Map<string, [number, number]> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const out = new Map<string, [number, number]>()
  const corner = (node: BoardNode, depth: number): [number, number] => {
    const known = out.get(node.id)
    if (known) return known
    const own: [number, number] = [Number((node as { x?: unknown }).x) || 0, Number((node as { y?: unknown }).y) || 0]
    const parent = parentOf(node)
    const frame = parent ? byId.get(parent) : undefined
    const result: [number, number] = frame && depth < 50 ? ((base) => [base[0] + own[0], base[1] + own[1]] as [number, number])(corner(frame, depth + 1)) : own
    out.set(node.id, result)
    return result
  }
  for (const node of nodes) corner(node, 0)
  return out
}
