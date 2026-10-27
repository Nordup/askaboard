import { isInk, isKnown, type BoardNode } from './board-format'

/**
 * What list_boards and open_board (main/boards.ts) know of one board without opening
 * it: counts by unit, its first title words, and the text it holds, for
 * search. The same functions read a closed board from its parsed file (main)
 * and the open board from the renderer's memory, unsaved changes included.
 * Handwriting is ink, not text: it is counted, never searched.
 */

export interface BoardDigest {
  /** The learner's ink strokes (closed boards are not grouped into ink groups: that needs the layout). */
  learnerStrokes: number
  /** Top-level items by the agent that are not ink. */
  agentItems: number
  /** The agent's ink strokes. */
  agentStrokes: number
  /** Distinct node.scene values. */
  scenes: number
  /** Top-level items by the learner that are not ink, orphans and unknown kinds. */
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

/** A rect in whole board points: each edge rounded, the size from the rounded edges. Every place and every region argument use it, so they agree. */
export function wholeRect(region: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const x = Math.round(region.x)
  const y = Math.round(region.y)
  return { x, y, width: Math.max(1, Math.round(region.x + region.width) - x), height: Math.max(1, Math.round(region.y + region.height) - y) }
}

/** "x,y w×h" in whole board points. */
export function placeText(region: { x: number; y: number; width: number; height: number } | null): string {
  if (!region) return '(no layout)'
  const r = wholeRect(region)
  return `${r.x},${r.y} ${r.width}×${r.height}`
}

const plain = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[*\\${}^_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const nameOf = (node: BoardNode): string | undefined => (typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined)
const parentOf = (node: BoardNode): string | undefined => (typeof (node as { parent?: unknown }).parent === 'string' ? ((node as { parent: string }).parent || undefined) : undefined)
const authorOf = (node: BoardNode): 'agent' | 'learner' => ((node as { author?: unknown }).author === 'agent' ? 'agent' : 'learner')

/** The font size of a text node in points, when its style sets one. */
function fontSize(node: BoardNode): number {
  const style = (node as { style?: Record<string, unknown> }).style
  const raw = style ? (style.fontSize ?? style['font-size']) : undefined
  const value = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(value) ? value : 0
}

function svgText(markup: string): string {
  return [...markup.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1].replace(/<[^>]*>/g, '')).join(' ')
}

export function digestBoard(nodes: readonly BoardNode[]): BoardDigest {
  const ids = new Set(nodes.map((node) => node.id))
  const scenes = new Set<string>()
  let learnerStrokes = 0
  let agentStrokes = 0
  let agentItems = 0
  let other = 0
  let heading: { size: number; seq: number; text: string } | null = null
  let firstFrame: { seq: number; text: string } | null = null
  for (const node of nodes) {
    const scene = (node as { scene?: unknown }).scene
    if (typeof scene === 'string' && scene) scenes.add(scene)
    const agent = authorOf(node) === 'agent'
    if (isInk(node)) {
      if (agent) agentStrokes++
      else learnerStrokes++
      continue
    }
    const parent = parentOf(node)
    const topLevel = !parent
    if (!isKnown(node) || (parent && !ids.has(parent))) other++
    else if (topLevel) {
      if (agent) agentItems++
      else other++
    }
    if (!agent) continue
    if (node.kind === 'text') {
      const text = plain(String((node as { text?: unknown }).text ?? ''))
      if ((text.match(/\p{L}/gu) ?? []).length < 3) continue
      const size = fontSize(node)
      if (!heading || size > heading.size || (size === heading.size && node.seq < heading.seq)) heading = { size, seq: node.seq, text }
    } else if (node.kind === 'frame' && topLevel && nameOf(node)) {
      if (!firstFrame || node.seq < firstFrame.seq) firstFrame = { seq: node.seq, text: nameOf(node) as string }
    }
  }
  const words = heading?.text ?? firstFrame?.text ?? null
  return { learnerStrokes, agentItems, agentStrokes, scenes: scenes.size, other, title: words ? firstWords(words, 60) : null }
}

/** The first words of a text, at most `max` characters. */
export function firstWords(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Every piece of text the board holds, per node (ink holds none). */
export function boardTexts(nodes: readonly BoardNode[]): TextEntry[] {
  const out: TextEntry[] = []
  for (const node of nodes) {
    if (isInk(node)) continue
    const fields: TextField[] = []
    const name = nameOf(node)
    if (name) fields.push({ field: 'name', text: name })
    const raw = node as unknown as Record<string, unknown>
    if (isKnown(node)) {
      if (node.kind === 'text' && typeof raw.text === 'string') fields.push({ field: 'text', text: plain(raw.text) })
      else if (node.kind === 'svg' && typeof raw.markup === 'string') {
        const text = plain(svgText(raw.markup))
        if (text) fields.push({ field: 'svg text', text })
      } else if (node.kind === 'image' && typeof raw.src === 'string' && !raw.src.startsWith('data:')) fields.push({ field: 'image', text: raw.src })
      else if (node.kind === 'live' && typeof raw.code === 'string') fields.push({ field: 'code', text: raw.code })
    } else {
      // A kind this app does not know: every string it stores.
      for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' && !['id', 'kind', 'name', 'parent', 'author', 'scene'].includes(key)) fields.push({ field: key, text: value })
    }
    if (!fields.length) continue
    const parent = parentOf(node)
    out.push({ id: node.id, kind: node.kind, ...(name ? { name } : {}), ...(parent ? { parent } : {}), fields })
  }
  return out
}

function contextOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30)
  const end = Math.min(text.length, at + length + 30)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

/** Case-insensitive search: one match per node, in its first field that holds the text. */
export function searchTexts(entries: readonly TextEntry[], query: string): TextMatch[] {
  const needle = query.toLowerCase().trim()
  if (!needle) return []
  const out: TextMatch[] = []
  for (const entry of entries) {
    for (const { field, text } of entry.fields) {
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      out.push({ id: entry.id, kind: entry.kind, ...(entry.name ? { name: entry.name } : {}), ...(entry.parent ? { parent: entry.parent } : {}), field, context: contextOf(text, at, needle.length) })
      break
    }
  }
  return out
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
