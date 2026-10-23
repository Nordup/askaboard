/** Canvas tools and ink settings. Step 0 keeps them as UI state only. */

export type ToolId = 'select' | 'pen' | 'highlighter' | 'eraser'

export interface InkColor {
  id: string
  label: string
  /** A CSS colour value, normally one of the --ink-* tokens. */
  value: string
}

export const INK_COLORS: readonly InkColor[] = [
  { id: 'white', label: 'White', value: 'var(--ink-white)' },
  { id: 'yellow', label: 'Yellow', value: 'var(--ink-yellow)' },
  { id: 'blue', label: 'Blue', value: 'var(--ink-blue)' },
  { id: 'green', label: 'Green', value: 'var(--ink-green)' },
  { id: 'pink', label: 'Pink', value: 'var(--ink-pink)' },
  { id: 'orange', label: 'Orange', value: 'var(--ink-orange)' }
]

export interface StrokeWidth {
  id: 'fine' | 'medium' | 'bold'
  label: string
  /** The stroke width in canvas pixels. */
  px: number
}

export const STROKE_WIDTHS: readonly StrokeWidth[] = [
  { id: 'fine', label: 'Fine', px: 2 },
  { id: 'medium', label: 'Medium', px: 4 },
  { id: 'bold', label: 'Bold', px: 8 }
]

export interface ToolState {
  tool: ToolId
  colorId: string
  widthId: StrokeWidth['id']
}
