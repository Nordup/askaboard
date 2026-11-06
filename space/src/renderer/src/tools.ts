/**
 * The board's tools and the one drawing style they share (decision B70).
 *
 * TOOLS is the single source for the tool pill, the tool keys and the
 * tooltips: a tool exists in all three or in none.
 */

import { AlignCenter, AlignLeft, AlignRight, Eraser, Hand, Lasso, MousePointer2, PenLine, Type, type LucideIcon } from 'lucide-react'

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'text' | 'eraser'

/** The fields of DrawStyle that a tool or an item kind uses: the style pill shows these. */
export type StyleField = 'color' | 'width' | 'pen' | 'size' | 'font' | 'align'

export interface ToolDef {
  id: ToolId
  label: string
  /** The letter key (no modifier). */
  key: string
  /** The number key (no modifier), when the tool has one. */
  digit?: string
  Icon: LucideIcon
  /** The style options this tool draws with, in the style pill's order. */
  style: readonly StyleField[]
}

/** The tools in the tool pill's order. A new tool is one row here. */
export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', digit: '1', Icon: MousePointer2, style: [] },
  { id: 'hand', label: 'Hand', key: 'H', Icon: Hand, style: [] },
  { id: 'pen', label: 'Pen', key: 'P', digit: '6', Icon: PenLine, style: ['color', 'width', 'pen'] },
  { id: 'text', label: 'Text', key: 'T', digit: '7', Icon: Type, style: ['color', 'size', 'font', 'align'] },
  { id: 'eraser', label: 'Eraser', key: 'E', digit: '0', Icon: Eraser, style: [] }
]

/** The Select button's icon in lasso mode. */
export const LassoIcon = Lasso

/** The tool for a key without modifiers (a letter in any case, or a digit), or undefined. */
export function toolForKey(key: string): ToolId | undefined {
  const upper = key.toUpperCase()
  return TOOLS.find((tool) => tool.key === upper || tool.digit === key)?.id
}

/** The tooltip of a tool: "Select — V or 1". */
export function toolTitle(tool: ToolDef): string {
  return `${tool.label} — ${tool.key}${tool.digit ? ` or ${tool.digit}` : ''}`
}

/** The lock keeps a shape tool after one shape (Q). */
export const LOCK_KEY = 'Q'

export interface InkColor {
  id: string
  label: string
  /** A hex colour. It is written into the board file. */
  value: string
}

/** Ink colours tuned for the dark canvas. Keep them in sync with the --ink-* tokens. */
export const INK_COLORS: readonly InkColor[] = [
  { id: 'white', label: 'White', value: '#ececef' },
  { id: 'yellow', label: 'Yellow', value: '#f5d76e' },
  { id: 'blue', label: 'Blue', value: '#6ea8ff' },
  { id: 'green', label: 'Green', value: '#5fd38d' },
  { id: 'pink', label: 'Pink', value: '#ff6b8b' },
  { id: 'orange', label: 'Orange', value: '#ff9f45' }
]

export interface StrokeWidth {
  label: string
  /** The nominal pen width in board points. A marker stroke is MARKER_SCALE times wider. */
  px: number
}

export const STROKE_WIDTHS: readonly StrokeWidth[] = [
  { label: 'Fine', px: 2 },
  { label: 'Medium', px: 3.5 },
  { label: 'Bold', px: 6 }
]

export type PenKind = 'pen' | 'marker'

export const PEN_KINDS: readonly { id: PenKind; label: string }[] = [
  { id: 'pen', label: 'Pen' },
  { id: 'marker', label: 'Marker' }
]

/** A marker stroke is this many times wider than a pen stroke. It is saved as InkNode.tool 'highlighter'. */
export const MARKER_SCALE = 4

export interface TextSize {
  id: string
  label: string
  /** The font size in board points. It is written into the board file as `style.fontSize: "<px>px"`. */
  px: number
}

/** Text sizes: Excalidraw's 16, 20, 28 and 36 px. New text was 20 px before the style pill, so M is the default. */
export const TEXT_SIZES: readonly TextSize[] = [
  { id: 'S', label: 'Small', px: 16 },
  { id: 'M', label: 'Medium', px: 20 },
  { id: 'L', label: 'Large', px: 28 },
  { id: 'XL', label: 'Extra large', px: 36 }
]

export type FontId = 'hand' | 'plain' | 'code'

/** Text fonts: the board's own font tokens (board/content.css), written into the board file as `style.fontFamily`. */
export const FONTS: readonly { id: FontId; label: string; value: string }[] = [
  { id: 'hand', label: 'Hand', value: 'var(--ls-hand)' },
  { id: 'plain', label: 'Plain', value: 'var(--ls-font)' },
  { id: 'code', label: 'Code', value: 'var(--ls-mono)' }
]

export type TextAlign = 'left' | 'center' | 'right'

/** Text alignment, written into the board file as `style.textAlign`. */
export const TEXT_ALIGNS: readonly { id: TextAlign; label: string; Icon: LucideIcon }[] = [
  { id: 'left', label: 'Align left', Icon: AlignLeft },
  { id: 'center', label: 'Align centre', Icon: AlignCenter },
  { id: 'right', label: 'Align right', Icon: AlignRight }
]

/** The one style that every tool draws with; each tool uses some of its fields (ToolDef.style). */
export interface DrawStyle {
  /** A hex colour from INK_COLORS (any colour string on an item). */
  color: string
  /** The nominal pen width in board points (STROKE_WIDTHS). */
  width: number
  pen: PenKind
  /** The text size in board points (TEXT_SIZES). */
  size: number
  font: FontId
  align: TextAlign
}

export interface ToolState {
  tool: ToolId
  /** What a drag on an empty board does with the Select tool. A second press on Select switches it. */
  selectMode: 'box' | 'lasso'
  /** Keep a shape tool after one shape. */
  lock: boolean
  style: DrawStyle
}

export const INITIAL_TOOLS: ToolState = {
  tool: 'select',
  selectMode: 'box',
  lock: false,
  style: { color: INK_COLORS[0].value, width: STROKE_WIDTHS[1].px, pen: 'pen', size: TEXT_SIZES[1].px, font: 'hand', align: 'left' }
}

/** Choose a tool: a press on Select while it is active switches between the box and the lasso. */
export function chooseTool(state: ToolState, tool: ToolId): ToolState {
  if (tool === 'select' && state.tool === 'select') return { ...state, selectMode: state.selectMode === 'box' ? 'lasso' : 'box' }
  return state.tool === tool ? state : { ...state, tool }
}
