/**
 * The board's tools and the one drawing style they share (decision B70).
 *
 * TOOLS is the single source for the tool pill, the tool keys and the
 * tooltips: a tool exists in all three or in none.
 */

import { AlignCenter, AlignLeft, AlignRight, Circle, Eraser, Hand, Lasso, Minus, MousePointer2, MoveHorizontal, MoveRight, MoveUpRight, PenLine, Slash, Square, Type, type LucideIcon } from 'lucide-react'
import type { ShapeFill, ShapeHeads, ShapeKind, ShapeLine } from '@shared/board-format'

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'text' | 'eraser'

/** The fields of DrawStyle that a tool or an item kind uses: the style pill shows these. */
export type StyleField = 'color' | 'fill' | 'width' | 'line' | 'heads' | 'pen' | 'size' | 'font' | 'align'

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
  /** The tool pill puts a divider between groups: moving, shapes, then the pen, text and eraser. */
  group: 'move' | 'shape' | 'mark'
}

/** The tools in the tool pill's order. A new tool is one row here. */
export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', digit: '1', Icon: MousePointer2, style: [], group: 'move' },
  { id: 'hand', label: 'Hand', key: 'H', Icon: Hand, style: [], group: 'move' },
  { id: 'rect', label: 'Rectangle', key: 'R', digit: '2', Icon: Square, style: ['color', 'fill', 'width', 'line'], group: 'shape' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', digit: '3', Icon: Circle, style: ['color', 'fill', 'width', 'line'], group: 'shape' },
  { id: 'arrow', label: 'Arrow', key: 'A', digit: '4', Icon: MoveUpRight, style: ['color', 'width', 'line', 'heads'], group: 'shape' },
  { id: 'line', label: 'Line', key: 'L', digit: '5', Icon: Slash, style: ['color', 'width', 'line'], group: 'shape' },
  { id: 'pen', label: 'Pen', key: 'P', digit: '6', Icon: PenLine, style: ['color', 'width', 'pen'], group: 'mark' },
  { id: 'text', label: 'Text', key: 'T', digit: '7', Icon: Type, style: ['color', 'size', 'font', 'align'], group: 'mark' },
  { id: 'eraser', label: 'Eraser', key: 'E', digit: '0', Icon: Eraser, style: [], group: 'mark' }
]

/** The Select button's icon in lasso mode. */
export const LassoIcon = Lasso

/** The tools that draw a shape (board-format ShapeNode): the tool id is the shape's kind. */
export function shapeTool(tool: ToolId): ShapeKind | null {
  return tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'line' ? tool : null
}

/** The tool for a key without modifiers (a letter in any case, or a digit), or undefined. */
export function toolForKey(key: string): ToolId | undefined {
  const upper = key.toUpperCase()
  return TOOLS.find((tool) => tool.key === upper || tool.digit === key)?.id
}

/** A tool's keys for its tooltip: "V or 1" (the tooltip shows "Select V or 1"). */
export function toolKeys(tool: ToolDef): string {
  return `${tool.key}${tool.digit ? ` or ${tool.digit}` : ''}`
}

/** The lock keeps a shape tool after one shape (Q). */
export const LOCK_KEY = 'Q'

export interface InkColor {
  id: string
  label: string
  /** A hex colour. It is written into the board file. */
  value: string
}

/**
 * Ink colours: the board's own palette (live/colors.ts names and the --ls-* tokens), the same
 * colours scenes draw with, so the learner's ink and the agent's drawing match. Keep them in sync
 * with the --ink-* tokens.
 */
export const INK_COLORS: readonly InkColor[] = [
  { id: 'white', label: 'White', value: '#ececef' },
  { id: 'blue', label: 'Blue', value: '#6e8bff' },
  { id: 'purple', label: 'Purple', value: '#b58cff' },
  { id: 'yellow', label: 'Yellow', value: '#f5d76e' },
  { id: 'green', label: 'Green', value: '#5fd38d' },
  { id: 'pink', label: 'Pink', value: '#ff6b8b' }
]

export type WidthStep = 'fine' | 'medium' | 'bold'

/**
 * The width steps of the style pill. Each kind of item maps a step to its own width (board points):
 * the pen keeps its widths (decision B69), and a shape draws an even line that is finer than ink.
 */
export const WIDTH_STEPS: readonly { id: WidthStep; label: string }[] = [
  { id: 'fine', label: 'Fine' },
  { id: 'medium', label: 'Medium' },
  { id: 'bold', label: 'Bold' }
]

/** The nominal pen width of each step. A marker stroke is MARKER_SCALE times wider. */
export const PEN_WIDTHS: Record<WidthStep, number> = { fine: 2, medium: 3.5, bold: 6 }

/** The even line width of a shape (rectangle, ellipse, arrow, line) at each step. */
export const SHAPE_WIDTHS: Record<WidthStep, number> = { fine: 1.5, medium: 2.5, bold: 4 }

/** The step whose width in `table` is exactly `width`, or undefined (an agent's or an older shape's width matches none). */
export function widthStep(table: Record<WidthStep, number>, width: number): WidthStep | undefined {
  return WIDTH_STEPS.find((step) => table[step.id] === width)?.id
}

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

/** Text sizes (founder, 2026-11-06). M is the default for new text. */
export const TEXT_SIZES: readonly TextSize[] = [
  { id: 'S', label: 'Small', px: 18 },
  { id: 'M', label: 'Medium', px: 24 },
  { id: 'L', label: 'Large', px: 32 },
  { id: 'XL', label: 'Extra large', px: 44 }
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

/** A shape's fill: none, the colour at a low alpha, or the colour. Shown as small squares. */
export const FILLS: readonly { id: ShapeFill; label: string }[] = [
  { id: 'none', label: 'No fill' },
  { id: 'light', label: 'Light fill' },
  { id: 'solid', label: 'Solid fill' }
]

/** A shape's line. Shown as a bar in its pattern. */
export const LINE_STYLES: readonly { id: ShapeLine; label: string }[] = [
  { id: 'solid', label: 'Solid line' },
  { id: 'dashed', label: 'Dashed line' },
  { id: 'dotted', label: 'Dotted line' }
]

/** An arrow's heads: at its end, at both ends, or none. */
export const ARROW_HEADS: readonly { id: ShapeHeads; label: string; Icon: LucideIcon }[] = [
  { id: 'end', label: 'One head', Icon: MoveRight },
  { id: 'both', label: 'Two heads', Icon: MoveHorizontal },
  { id: 'none', label: 'No heads', Icon: Minus }
]

/** The one style that every tool draws with; each tool uses some of its fields (ToolDef.style). */
export interface DrawStyle {
  /** A hex colour from INK_COLORS (any colour string on an item). */
  color: string
  /** The width step: each kind maps it to its own width (PEN_WIDTHS, SHAPE_WIDTHS). */
  width: WidthStep
  fill: ShapeFill
  line: ShapeLine
  heads: ShapeHeads
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
  style: { color: INK_COLORS[0].value, width: 'medium', fill: 'none', line: 'solid', heads: 'end', pen: 'pen', size: TEXT_SIZES[1].px, font: 'hand', align: 'left' }
}

/** Choose a tool: a press on Select while it is active switches between the box and the lasso. */
export function chooseTool(state: ToolState, tool: ToolId): ToolState {
  if (tool === 'select' && state.tool === 'select') return { ...state, selectMode: state.selectMode === 'box' ? 'lasso' : 'box' }
  return state.tool === tool ? state : { ...state, tool }
}
