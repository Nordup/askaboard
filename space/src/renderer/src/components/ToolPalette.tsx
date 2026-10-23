import type { CSSProperties } from 'react'
import { Eraser, Highlighter, Lasso, PenLine, type LucideIcon } from 'lucide-react'
import { INK_COLORS, STROKE_WIDTHS, type ToolId, type ToolState } from '../tools'

const TOOLS: readonly { id: ToolId; label: string; key: string; Icon: LucideIcon }[] = [
  { id: 'select', label: 'Select', key: 'V', Icon: Lasso },
  { id: 'pen', label: 'Pen', key: 'P', Icon: PenLine },
  { id: 'highlighter', label: 'Highlighter', key: 'H', Icon: Highlighter },
  { id: 'eraser', label: 'Eraser', key: 'E', Icon: Eraser }
]

interface ToolPaletteProps {
  state: ToolState
  onChange: (next: ToolState) => void
}

export function ToolPalette({ state, onChange }: ToolPaletteProps) {
  return (
    <div className="palette" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map(({ id, label, key, Icon }) => (
        <button
          key={id}
          className="tool"
          title={`${label} (${key})`}
          aria-label={label}
          aria-pressed={state.tool === id}
          onClick={() => onChange({ ...state, tool: id })}
        >
          <Icon size={17} strokeWidth={1.75} />
        </button>
      ))}

      <span className="palette__divider" />

      <div className="swatches">
        {INK_COLORS.map((color) => (
          <button
            key={color.id}
            className="swatch"
            title={color.label}
            aria-label={`${color.label} ink`}
            aria-pressed={state.colorId === color.id}
            style={{ '--swatch': color.value } as CSSProperties}
            onClick={() => onChange({ ...state, colorId: color.id })}
          >
            <span className="swatch__dot" />
          </button>
        ))}
      </div>

      <span className="palette__divider" />

      <div className="widths">
        {STROKE_WIDTHS.map((width) => (
          <button
            key={width.id}
            className="width"
            title={`${width.label} stroke`}
            aria-label={`${width.label} stroke`}
            aria-pressed={state.widthId === width.id}
            onClick={() => onChange({ ...state, widthId: width.id })}
          >
            <span className="width__bar" style={{ height: Math.max(1.5, width.px / 2) }} />
          </button>
        ))}
      </div>
    </div>
  )
}
