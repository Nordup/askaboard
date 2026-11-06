import { tip } from './Tooltip'
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { CopyPlus, Ellipsis, Highlighter, Lock, LockOpen, Minus, PenLine, Plus, Redo, Trash2, Undo, type LucideIcon } from 'lucide-react'
import { ARROW_HEADS, FILLS, FONTS, INK_COLORS, LassoIcon, LINE_STYLES, LOCK_KEY, PEN_KINDS, SHAPE_WIDTHS, TEXT_ALIGNS, TEXT_SIZES, TOOLS, toolKeys, WIDTH_STEPS, type PenKind, type StyleField, type ToolState } from '../tools'
import { styleFields, type SelectionStyle, type StylePatch } from '../board/style'
import { commandRow, KEYS, ZOOM_COMMANDS, type BoardCommand, type CommandContext, type ZoomCommand } from '../board/commands'
import { BoardMenu } from './BoardMenu'
import { PenRing } from './InkGlyph'

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
  /** A zoom command: the % zooms to 100%. */
  onZoom(command: ZoomCommand): void
  onUndo(): void
  onRedo(): void
}

const PEN_ICONS: Record<PenKind, LucideIcon> = { pen: PenLine, marker: Highlighter }

/** Lucide icons: their size comes from the pill's tokens (app.css `.tool > .lucide`, `.option > .lucide`). */
const ICON = { strokeWidth: 1.75 } as const

/** The More menu opens this far above its pill (CSS px), as the style pill sits above the tool pill. */
const MENU_GAP = 8

type Rect = { left: number; top: number; right: number; bottom: number }

/** The window rects (client CSS px) of the visible board control pills; empty when no board is open. */
export function boardControlsArea(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>('.canvas > .board-controls .pill-bar, .canvas > .board-controls .board-controls__corner')].map((pill) => {
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

/** The bottom controls over the board: zoom, undo, the tools and the style of the tool or the selection (decision U10). */
export function BoardControls(props: BoardControlsProps) {
  const { tools, zoom } = props
  const style = stylePillOf(tools, props.selection)
  const rootRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const styleKey = style ? `${style.fields.join(' ')} ${style.selection ? `commands ${style.selection.editable}` : ''}` : ''
  /**
   * The style pill of this key leaves out Duplicate and Delete (More still has them): its whole width does not
   * fit in the canvas. `fullWidth` is that whole width, measured while the pill had them.
   */
  const [compactKey, setCompactKey] = useState<string | null>(null)
  const compact = compactKey === styleKey && !!style?.selection
  const fullWidthRef = useRef(0)

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
      if (!compact) fullWidthRef.current = box.width
      const tooWide = !!style?.selection && fullWidthRef.current > bounds.width - margin * 2
      if (tooWide !== compact) {
        setCompactKey(tooWide ? styleKey : null)
        return
      }
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
    // style.selection is in styleKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey, compact])

  return (
    <div className="board-controls" ref={rootRef}>
      <div className="board-controls__corner" role="toolbar" aria-label="Zoom and history">
        <button className="tool" {...tip('Zoom out', KEYS.zoomOut)} aria-label="Zoom out" onClick={props.onZoomOut}>
          <Minus {...ICON} />
        </button>
        <ZoomLabel zoom={zoom} onZoom={props.onZoom} />
        <button className="tool" {...tip('Zoom in', KEYS.zoomIn)} aria-label="Zoom in" onClick={props.onZoomIn}>
          <Plus {...ICON} />
        </button>
        <span className="board-controls__gap" />
        <button className="tool" {...tip('Undo', KEYS.undo)} aria-label="Undo" onClick={props.onUndo}>
          <Undo {...ICON} />
        </button>
        <button className="tool" {...tip('Redo', KEYS.redo)} aria-label="Redo" onClick={props.onRedo}>
          <Redo {...ICON} />
        </button>
      </div>

      <div className="board-controls__center">
        {style && (
          <div className="pill-bar board-controls__style" ref={styleRef} role="toolbar" aria-label="Style">
            <StyleOptions state={style} onStyle={props.onStyle} />
            {style.selection && (
              <SelectionCommands divider={style.fields.length > 0} editable={style.selection.editable} compact={compact} onCommand={props.onCommand} commandContext={props.commandContext} />
            )}
          </div>
        )}
        <div className="pill-bar board-controls__tools" role="toolbar" aria-label="Tools">
          <button
            className={tools.lock ? 'tool' : 'tool tool--quiet'}
            {...tip('Keep tool', LOCK_KEY)}
            aria-label="Keep tool"
            aria-pressed={tools.lock}
            onClick={props.onToggleLock}
          >
            {tools.lock ? <Lock {...ICON} /> : <LockOpen {...ICON} />}
          </button>
          <span className="pill-bar__divider" />
          {TOOLS.map((tool, i) => {
            const Icon = tool.id === 'select' && tools.selectMode === 'lasso' ? LassoIcon : tool.Icon
            return (
              <Fragment key={tool.id}>
                {i > 0 && TOOLS[i - 1].group !== tool.group && <span className="pill-bar__divider" />}
                <button
                  className="tool"
                  style={tool.iconScale ? ({ '--icon-scale': tool.iconScale } as CSSProperties) : undefined}
                  {...tip(tool.label, toolKeys(tool))}
                  aria-label={tool.label}
                  aria-pressed={tools.tool === tool.id}
                  onClick={() => props.onChooseTool(tool.id)}
                >
                  <Icon {...ICON} />
                </button>
              </Fragment>
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
        {...tip(color.label)}
        aria-label={color.label}
        aria-pressed={values.color === color.value}
        style={{ '--swatch': color.value } as CSSProperties}
        onClick={() => onStyle({ color: color.value })}
      >
        <PenRing name={color.id} className="swatch__dot" />
      </button>
    ))
  } else if (field === 'width') {
    // One bar per step, as thick as a shape line of that step (the pen maps the step to its own width).
    options = WIDTH_STEPS.map((step) => (
      <button
        key={step.id}
        className="option"
        {...tip(`${step.label} stroke`)}
        aria-label={`${step.label} stroke`}
        aria-pressed={values.width === step.id}
        onClick={() => onStyle({ width: step.id })}
      >
        <span className="option__bar" style={{ height: SHAPE_WIDTHS[step.id] }} />
      </button>
    ))
  } else if (field === 'fill') {
    options = FILLS.map((fill) => (
      <button key={fill.id} className="option" {...tip(fill.label)} aria-label={fill.label} aria-pressed={values.fill === fill.id} onClick={() => onStyle({ fill: fill.id })}>
        <span className="option__fill" data-fill={fill.id} />
      </button>
    ))
  } else if (field === 'line') {
    options = LINE_STYLES.map((line) => (
      <button key={line.id} className="option" {...tip(line.label)} aria-label={line.label} aria-pressed={values.line === line.id} onClick={() => onStyle({ line: line.id })}>
        <svg className="option__line" viewBox="0 0 18 4" aria-hidden="true">
          <line x1="2" y1="2" x2="16" y2="2" strokeDasharray={line.id === 'dashed' ? '4 3' : line.id === 'dotted' ? '0 3.5' : undefined} />
        </svg>
      </button>
    ))
  } else if (field === 'heads') {
    options = ARROW_HEADS.map(({ id, label, Icon }) => (
      <button key={id} className="option" {...tip(label)} aria-label={label} aria-pressed={values.heads === id} onClick={() => onStyle({ heads: id })}>
        <Icon {...ICON} />
      </button>
    ))
  } else if (field === 'size') {
    options = TEXT_SIZES.map((size) => (
      <button key={size.id} className="option option--text" {...tip(`${size.label} text`)} aria-label={`${size.label} text`} aria-pressed={values.size === size.px} onClick={() => onStyle({ size: size.px })}>
        {size.id}
      </button>
    ))
  } else if (field === 'font') {
    options = FONTS.map((font) => (
      <button key={font.id} className="option option--text" aria-label={`${font.label} font`} aria-pressed={values.font === font.id} onClick={() => onStyle({ font: font.id })}>
        {font.label}
      </button>
    ))
  } else if (field === 'align') {
    options = TEXT_ALIGNS.map(({ id, label, Icon }) => (
      <button key={id} className="option" {...tip(label)} aria-label={label} aria-pressed={values.align === id} onClick={() => onStyle({ align: id })}>
        <Icon {...ICON} />
      </button>
    ))
  } else {
    options = PEN_KINDS.map((kind) => {
      const Icon = PEN_ICONS[kind.id]
      return (
        <button key={kind.id} className="option" {...tip(kind.label)} aria-label={kind.label} aria-pressed={values.pen === kind.id} onClick={() => onStyle({ pen: kind.id })}>
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

/**
 * The end of the style pill for a selection: Duplicate, Delete and More, a menu of every board command (the right-click menu's list).
 * `compact`: the pill would not fit in the canvas, so it shows More alone.
 */
function SelectionCommands(props: { divider: boolean; editable: boolean; compact: boolean; onCommand(command: BoardCommand): void; commandContext(): CommandContext | null }) {
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
      {!props.compact && (
        <button className="option" {...tip(duplicate.label, duplicate.keys)} aria-label={duplicate.label} onClick={() => onCommand('duplicate')}>
          <CopyPlus {...ICON} />
        </button>
      )}
      {props.editable && !props.compact && (
        <button className="option" {...tip(remove.label, remove.keys)} aria-label={remove.label} onClick={() => onCommand('delete')}>
          <Trash2 {...ICON} />
        </button>
      )}
      <button ref={moreRef} className="option" {...tip('More')} aria-label="More" aria-haspopup="menu" aria-expanded={menu !== null} onClick={toggleMenu}>
        <Ellipsis {...ICON} />
      </button>
      {menu && <BoardMenu x={menu.x} y={menu.y} above context={menu.context} onCommand={onCommand} onClose={close} toggle={moreRef.current} />}
    </>
  )
}

/** The zoom pill's %: a click zooms to 100% (⇧1 and ⇧2 fit the board and the selection: the keys panel lists them). */
function ZoomLabel(props: { zoom: number; onZoom(command: ZoomCommand): void }) {
  const reset = ZOOM_COMMANDS.find((row) => row.id === 'reset') as (typeof ZOOM_COMMANDS)[number]
  return (
    <button className="zoom-label" {...tip(reset.label, reset.keys)} aria-label={reset.label} onClick={() => props.onZoom('reset')}>
      {Math.round(props.zoom * 100)}%
    </button>
  )
}
