import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { CopyPlus, Ellipsis, Highlighter, Lock, LockOpen, Minus, PenLine, Plus, Redo2, Trash2, Undo2, type LucideIcon } from 'lucide-react'
import { isMac, shortcut } from '../platform'
import { FONTS, INK_COLORS, LassoIcon, LOCK_KEY, PEN_KINDS, STROKE_WIDTHS, TEXT_ALIGNS, TEXT_SIZES, TOOLS, toolTitle, type PenKind, type StyleField, type ToolState } from '../tools'
import { styleFields, type SelectionStyle, type StylePatch } from '../board/style'
import { commandRow, type BoardCommand, type CommandContext } from '../board/commands'
import { BoardMenu } from './BoardMenu'

/**
 * What the style pill shows: its fields, with the values of the tool or of the selection (a missing value
 * matches no option), and for a selection the commands after them.
 */
interface StylePillState {
  fields: readonly StyleField[]
  values: StylePatch
  /** A selection: Duplicate, Delete (when an item may change) and More end the pill. */
  selection?: { editable: boolean }
}

/** The style pill for a tool that draws with a style, or for the Select tool's selection; null when neither has one. */
function stylePillOf(tools: ToolState, selection: SelectionStyle | null): StylePillState | null {
  const tool = TOOLS.find((each) => each.id === tools.tool)
  if (tool?.style.length) return { fields: tool.style, values: tools.style }
  if (tools.tool !== 'select' || !selection) return null
  return { fields: styleFields(selection.kinds), values: selection.style, selection: { editable: selection.editable } }
}

interface BoardControlsProps {
  tools: ToolState
  /** The zoom as a share of the home zoom, where 1 is 100%. */
  zoom: number
  /** The selection's style (Board onSelectionStyle). */
  selection: SelectionStyle | null
  onChooseTool(tool: ToolState['tool']): void
  onToggleLock(): void
  onStyle(patch: StylePatch): void
  /** Run a board command on the selection (board/commands.ts). */
  onCommand(command: BoardCommand): void
  /** What the commands depend on now, for the More menu. */
  commandContext(): CommandContext | null
  onZoomIn(): void
  onZoomOut(): void
  onResetZoom(): void
  onUndo(): void
  onRedo(): void
}

const PEN_ICONS: Record<PenKind, LucideIcon> = { pen: PenLine, marker: Highlighter }

const ICON = { size: 17, strokeWidth: 1.75 } as const

/** The More menu opens this far above the style pill (CSS px), as the style pill sits above the tool pill. */
const MENU_GAP = 8

type Rect = { left: number; top: number; right: number; bottom: number }

/** The window rects (client CSS px) of the visible board control pills; empty when no board is open. */
export function boardControlsArea(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>('.canvas > .board-controls .pill-bar')].map((pill) => {
    const box = pill.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
  })
}

/** The top of the bottom row (the tool pill) in the canvas's own CSS px, or null without the controls. */
export function boardControlsTop(canvas: HTMLElement): number | null {
  const tools = canvas.querySelector<HTMLElement>(':scope > .board-controls .board-controls__tools')
  if (!tools) return null
  return tools.getBoundingClientRect().top - canvas.getBoundingClientRect().top - canvas.clientTop
}

/** The bottom controls over the board: zoom, undo, the tools and the style of the tool or the selection (decision U8). */
export function BoardControls(props: BoardControlsProps) {
  const { tools, zoom } = props
  const style = stylePillOf(tools, props.selection)
  const rootRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const styleKey = style ? `${style.fields.join(' ')} ${style.selection ? `commands ${style.selection.editable}` : ''}` : ''

  // The style pill is centred on the tool pill; one measured shift keeps it a margin inside the canvas.
  useLayoutEffect(() => {
    const root = rootRef.current
    const pill = styleRef.current
    if (!root || !pill) return
    const place = (): void => {
      pill.style.setProperty('--style-shift', '0px')
      const margin = parseFloat(getComputedStyle(root).paddingLeft) || 0
      const bounds = root.getBoundingClientRect()
      const box = pill.getBoundingClientRect()
      const over = bounds.left + margin - box.left
      const under = bounds.right - margin - box.right
      const shift = over > 0 ? over : under < 0 ? Math.max(under, over) : 0
      // On whole pixels: a centred pill can start at half a pixel, which blurs its icons.
      pill.style.setProperty('--style-shift', `${Math.round(box.left + shift) - box.left}px`)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(root)
    observer.observe(pill)
    return () => observer.disconnect()
  }, [styleKey])

  return (
    <div className="board-controls" ref={rootRef}>
      <div className="board-controls__start">
        <div className="pill-bar" role="toolbar" aria-label="Zoom">
          <button className="tool" title={`Zoom out — ${shortcut('-')}`} aria-label="Zoom out" onClick={props.onZoomOut}>
            <Minus {...ICON} />
          </button>
          <button className="zoom-label" title={`Reset zoom to 100% — ${shortcut('0')}`} onClick={props.onResetZoom}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="tool" title={`Zoom in — ${shortcut('+')}`} aria-label="Zoom in" onClick={props.onZoomIn}>
            <Plus {...ICON} />
          </button>
        </div>
        <div className="pill-bar" role="toolbar" aria-label="History">
          <button className="tool" title={`Undo — ${shortcut('Z')}`} aria-label="Undo" onClick={props.onUndo}>
            <Undo2 {...ICON} />
          </button>
          <button className="tool" title={`Redo — ${shortcut(isMac ? '⇧Z' : 'Shift+Z')}`} aria-label="Redo" onClick={props.onRedo}>
            <Redo2 {...ICON} />
          </button>
        </div>
      </div>

      <div className="board-controls__center">
        {style && (
          <div className="pill-bar board-controls__style" ref={styleRef} role="toolbar" aria-label="Style">
            <StyleOptions state={style} onStyle={props.onStyle} />
            {style.selection && (
              <SelectionCommands divider={style.fields.length > 0} editable={style.selection.editable} onCommand={props.onCommand} commandContext={props.commandContext} />
            )}
          </div>
        )}
        <div className="pill-bar board-controls__tools" role="toolbar" aria-label="Tools">
          <button
            className={tools.lock ? 'tool' : 'tool tool--quiet'}
            title={`Keep tool — ${LOCK_KEY}`}
            aria-label="Keep tool"
            aria-pressed={tools.lock}
            onClick={props.onToggleLock}
          >
            {tools.lock ? <Lock {...ICON} /> : <LockOpen {...ICON} />}
          </button>
          <span className="pill-bar__divider" />
          {TOOLS.map((tool) => {
            const Icon = tool.id === 'select' && tools.selectMode === 'lasso' ? LassoIcon : tool.Icon
            return (
              <button
                key={tool.id}
                className="tool"
                title={toolTitle(tool)}
                aria-label={tool.label}
                aria-pressed={tools.tool === tool.id}
                onClick={() => props.onChooseTool(tool.id)}
              >
                <Icon {...ICON} />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The style pill's groups, one per field, with a divider between groups. */
function StyleOptions({ state, onStyle }: { state: StylePillState; onStyle(patch: StylePatch): void }) {
  const { fields, values } = state
  return fields.map((field, i) => (
    <StyleGroup key={field} field={field} values={values} onStyle={onStyle} divider={i > 0} />
  ))
}

function StyleGroup({ field, values, onStyle, divider }: { field: StyleField; values: StylePatch; onStyle(patch: StylePatch): void; divider: boolean }) {
  let options
  if (field === 'color') {
    options = INK_COLORS.map((color) => (
      <button
        key={color.id}
        className="swatch"
        title={color.label}
        aria-label={color.label}
        aria-pressed={values.color === color.value}
        style={{ '--swatch': color.value } as CSSProperties}
        onClick={() => onStyle({ color: color.value })}
      >
        <span className="swatch__dot" />
      </button>
    ))
  } else if (field === 'width') {
    options = STROKE_WIDTHS.map((width) => (
      <button
        key={width.px}
        className="option"
        title={`${width.label} stroke`}
        aria-label={`${width.label} stroke`}
        aria-pressed={values.width === width.px}
        onClick={() => onStyle({ width: width.px })}
      >
        <span className="option__bar" style={{ height: Math.max(1.5, width.px / 2) }} />
      </button>
    ))
  } else if (field === 'size') {
    options = TEXT_SIZES.map((size) => (
      <button key={size.id} className="option option--text" title={`${size.label} text`} aria-label={`${size.label} text`} aria-pressed={values.size === size.px} onClick={() => onStyle({ size: size.px })}>
        {size.id}
      </button>
    ))
  } else if (field === 'font') {
    options = FONTS.map((font) => (
      <button key={font.id} className="option option--text" title={`${font.label} font`} aria-label={`${font.label} font`} aria-pressed={values.font === font.id} onClick={() => onStyle({ font: font.id })}>
        {font.label}
      </button>
    ))
  } else if (field === 'align') {
    options = TEXT_ALIGNS.map(({ id, label, Icon }) => (
      <button key={id} className="option" title={label} aria-label={label} aria-pressed={values.align === id} onClick={() => onStyle({ align: id })}>
        <Icon {...ICON} />
      </button>
    ))
  } else {
    options = PEN_KINDS.map((kind) => {
      const Icon = PEN_ICONS[kind.id]
      return (
        <button key={kind.id} className="option" title={kind.label} aria-label={kind.label} aria-pressed={values.pen === kind.id} onClick={() => onStyle({ pen: kind.id })}>
          <Icon {...ICON} />
        </button>
      )
    })
  }
  return (
    <>
      {divider && <span className="pill-bar__divider" />}
      {options}
    </>
  )
}

/** The end of the style pill for a selection: Duplicate, Delete and More, a menu of every board command (the right-click menu's list). */
function SelectionCommands(props: { divider: boolean; editable: boolean; onCommand(command: BoardCommand): void; commandContext(): CommandContext | null }) {
  const { onCommand, commandContext } = props
  const moreRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; context: CommandContext } | null>(null)
  const close = useCallback(() => setMenu(null), [])
  const duplicate = commandRow('duplicate')
  const remove = commandRow('delete')
  const toggleMenu = (): void => {
    const button = moreRef.current
    const context = commandContext()
    if (menu || !button || !context) {
      setMenu(null)
      return
    }
    // Above the pill, with its left edge at the button.
    const top = (button.closest('.pill-bar') ?? button).getBoundingClientRect().top
    setMenu({ x: button.getBoundingClientRect().left, y: top - MENU_GAP, context })
  }
  return (
    <>
      {props.divider && <span className="pill-bar__divider" />}
      <button className="option" title={`${duplicate.label} — ${duplicate.keys}`} aria-label={duplicate.label} onClick={() => onCommand('duplicate')}>
        <CopyPlus {...ICON} />
      </button>
      {props.editable && (
        <button className="option" title={`${remove.label} — ${remove.keys}`} aria-label={remove.label} onClick={() => onCommand('delete')}>
          <Trash2 {...ICON} />
        </button>
      )}
      <button ref={moreRef} className="option" title="More" aria-label="More" aria-haspopup="menu" aria-expanded={menu !== null} onClick={toggleMenu}>
        <Ellipsis {...ICON} />
      </button>
      {menu && <BoardMenu x={menu.x} y={menu.y} above context={menu.context} onCommand={onCommand} onClose={close} toggle={moreRef.current} />}
    </>
  )
}
