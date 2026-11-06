/**
 * How the one drawing style (tools.ts DrawStyle) maps onto board items. This
 * is the only place that knows which item field holds a style value: the
 * style pill reads items through styleOf and changes them through restyle.
 */

import { isKnown, type NodeStyle } from '@shared/board-format'
import { MARKER_SCALE, type DrawStyle, type StyleField } from '../tools'
import type { BoardNode } from './types'

/** A part of DrawStyle: what one press in the style pill changes. */
export type StylePatch = Partial<DrawStyle>

/** The item kinds that take a style. */
export type StyleKind = 'ink' | 'text' | 'frame'

const KIND_FIELDS: Record<StyleKind, readonly StyleField[]> = {
  ink: ['color', 'width'],
  text: ['color'],
  frame: ['color']
}

/** The order of the style pill's groups. */
const FIELD_ORDER: readonly StyleField[] = ['color', 'width', 'pen']

/** The fields that items of these kinds use, in the style pill's order. */
export function styleFields(kinds: readonly StyleKind[]): StyleField[] {
  return FIELD_ORDER.filter((field) => kinds.some((kind) => KIND_FIELDS[kind].includes(field)))
}

/** The style kind of an item the learner may restyle, or null (locked, foreign, or a kind with no style). */
export function styleKind(node: BoardNode): StyleKind | null {
  if (!isKnown(node) || node.locked) return null
  return node.kind === 'ink' || node.kind === 'text' || node.kind === 'frame' ? node.kind : null
}

const r2 = (value: number): number => Math.round(value * 100) / 100

/** The item's values in DrawStyle terms (only the fields its kind has). */
export function styleOf(node: BoardNode): StylePatch {
  if (!isKnown(node)) return {}
  if (node.kind === 'ink') {
    const marker = node.tool === 'highlighter'
    return { color: node.color, width: r2(marker ? node.width / MARKER_SCALE : node.width), pen: marker ? 'marker' : 'pen' }
  }
  if (node.kind === 'text') return node.style.color ? { color: node.style.color } : {}
  if (node.kind === 'frame') {
    const color = node.style.backgroundColor
    return typeof color === 'string' ? { color } : {}
  }
  return {}
}

/** The item with the patch applied, or the same item when nothing in the patch applies to it. */
export function restyle(node: BoardNode, patch: StylePatch): BoardNode {
  const kind = styleKind(node)
  if (!kind || !isKnown(node)) return node
  const fields = KIND_FIELDS[kind]
  const color = fields.includes('color') ? patch.color : undefined
  if (node.kind === 'ink') {
    const scale = node.tool === 'highlighter' ? MARKER_SCALE : 1
    const width = patch.width !== undefined ? patch.width * scale : node.width
    const nextColor = color ?? node.color
    return width === node.width && nextColor === node.color ? node : { ...node, color: nextColor, width }
  }
  if (color === undefined) return node
  if (node.kind === 'text') return node.style.color === color ? node : { ...node, style: { ...node.style, color } }
  if (node.kind === 'frame') {
    if (node.style.backgroundColor === color) return node
    const style: NodeStyle = { ...node.style, backgroundColor: color }
    delete style.background
    return { ...node, style }
  }
  return node
}

/** What the style pill shows for a selection: its style kinds and the values all its items share. */
export interface SelectionStyle {
  kinds: StyleKind[]
  style: StylePatch
}

/** The style of these items, or null when none of them takes a style. */
export function selectionStyle(nodes: readonly BoardNode[]): SelectionStyle | null {
  const kinds = new Set<StyleKind>()
  let shared: StylePatch | null = null
  for (const node of nodes) {
    const kind = styleKind(node)
    if (!kind) continue
    kinds.add(kind)
    const own = styleOf(node)
    if (!shared) {
      shared = own
      continue
    }
    const next: StylePatch = {}
    for (const field of FIELD_ORDER) {
      if (shared[field] !== undefined && shared[field] === own[field]) (next as Record<StyleField, unknown>)[field] = shared[field]
    }
    shared = next
  }
  return shared ? { kinds: [...kinds], style: shared } : null
}
