/** Canvas tools and ink settings. */

export type ToolId = 'select' | 'pen' | 'highlighter' | 'eraser'

/** Single-key shortcuts (no modifier). */
export const TOOL_KEYS: Record<string, ToolId> = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser' }

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
  id: 'fine' | 'medium' | 'bold'
  label: string
  /** The nominal pen width in board points. The highlighter is 4 times wider. */
  px: number
}

export const STROKE_WIDTHS: readonly StrokeWidth[] = [
  { id: 'fine', label: 'Fine', px: 2 },
  { id: 'medium', label: 'Medium', px: 3.5 },
  { id: 'bold', label: 'Bold', px: 6 }
]

export interface ToolState {
  tool: ToolId
  colorId: string
  widthId: StrokeWidth['id']
}

export function colorValue(state: ToolState): string {
  return (INK_COLORS.find((color) => color.id === state.colorId) ?? INK_COLORS[0]).value
}

export function widthValue(state: ToolState): number {
  return (STROKE_WIDTHS.find((width) => width.id === state.widthId) ?? STROKE_WIDTHS[1]).px
}
