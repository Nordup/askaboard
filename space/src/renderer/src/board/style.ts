/**
 * How the one drawing style (tools.ts DrawStyle) maps onto board items. This
 * is the only place that knows which item field holds a style value: the
 * style pill reads items through styleOf and changes them through restyle.
 */

import { isKnown, type NodeStyle } from '@shared/board-format'
import { FONTS, MARKER_SCALE, TEXT_ALIGNS, TEXT_SIZES, type DrawStyle, type StyleField } from '../tools'
import type { BoardNode } from './types'

/** A part of DrawStyle: what one press in the style pill changes. */
export type StylePatch = Partial<DrawStyle>

/** The item kinds that take a style. */
export type StyleKind = 'ink' | 'text' | 'frame'

const KIND_FIELDS: Record<StyleKind, readonly StyleField[]> = {
  ink: ['color', 'width'],
  text: ['color', 'size', 'font', 'align'],
  frame: ['color']
}

/** The order of the style pill's groups. */
const FIELD_ORDER: readonly StyleField[] = ['color', 'width', 'pen', 'size', 'font', 'align']

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
  if (node.kind === 'text') {
    // Only an exact option counts: a size from a corner drag or an agent's own font matches none.
    const { color, fontSize, fontFamily, textAlign } = node.style
    const size = TEXT_SIZES.find((option) => fontSize === `${option.px}px`)
    const font = FONTS.find((option) => fontFamily === option.value)
    const align = TEXT_ALIGNS.find((option) => textAlign === option.id)
    return {
      ...(typeof color === 'string' ? { color } : {}),
      ...(size ? { size: size.px } : {}),
      ...(font ? { font: font.id } : {}),
      ...(align ? { align: align.id } : {})
    }
  }
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
  if (node.kind === 'text') {
    const fontFamily = patch.font !== undefined ? FONTS.find((option) => option.id === patch.font)?.value : undefined
    const next: NodeStyle = {
      ...(color !== undefined ? { color } : {}),
      ...(patch.size !== undefined ? { fontSize: `${patch.size}px` } : {}),
      ...(fontFamily !== undefined ? { fontFamily } : {}),
      ...(patch.align !== undefined ? { textAlign: patch.align } : {})
    }
    const same = Object.entries(next).every(([key, value]) => node.style[key] === value)
    return same ? node : { ...node, style: { ...node.style, ...next } }
  }
  if (color === undefined) return node
  if (node.kind === 'frame') {
    if (node.style.backgroundColor === color) return node
    const style: NodeStyle = { ...node.style, backgroundColor: color }
    delete style.background
    return { ...node, style }
  }
  return node
}

/** What the style pill shows for a selection: its style kinds, the values all its items share, and whether any item may change. */
export interface SelectionStyle {
  /** Empty when nothing selected takes a style (an image, a locked item): the pill then shows only the commands. */
  kinds: StyleKind[]
  style: StylePatch
  /** Some selected item is not locked: it may be cut, deleted or reordered. */
  editable: boolean
}

/** The style of these items, or null when there are none. */
export function selectionStyle(nodes: readonly BoardNode[]): SelectionStyle | null {
  if (!nodes.length) return null
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
  const editable = nodes.some((node) => !(isKnown(node) && node.locked))
  return { kinds: [...kinds], style: shared ?? {}, editable }
}
