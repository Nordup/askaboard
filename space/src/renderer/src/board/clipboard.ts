import { isStroke, newItemId } from '@shared/board-format'
import { translateItems, unionRegions, strokeBounds } from './geometry'
import type { BoardItem, Point, StrokeItem } from './types'

/** Ported from web/src/board/clipboard.ts. The clipboard holds strokes only. */

const DUPLICATE_OFFSET: Point = [20, 20]
let internalClipboard: StrokeItem[] = []

export function writeInkClipboard(strokes: StrokeItem[]): void {
  internalClipboard = structuredClone(strokes)
}

export function readInkClipboard(): StrokeItem[] {
  return structuredClone(internalClipboard)
}

export function hasInkClipboard(): boolean {
  return internalClipboard.length > 0
}

export function copySelectedStrokes(items: BoardItem[], ids: readonly string[]): StrokeItem[] {
  const selected = new Set(ids)
  return structuredClone(items.filter((item): item is StrokeItem => isStroke(item) && selected.has(item.id)))
}

export function removeSelected(items: BoardItem[], ids: readonly string[]): BoardItem[] {
  const selected = new Set(ids)
  return items.filter((item) => !(isStroke(item) && selected.has(item.id)))
}

function withNewIds(strokes: BoardItem[]): StrokeItem[] {
  return strokes.filter(isStroke).map((stroke) => ({ ...stroke, id: newItemId() }))
}

/** Paste copies centred on a board anchor. */
export function pasteStrokes(items: BoardItem[], copied: StrokeItem[], anchor: Point): { items: BoardItem[]; insertedIds: string[] } {
  if (!copied.length) return { items, insertedIds: [] }
  const bounds = unionRegions(copied.map(strokeBounds))
  const delta: Point = bounds ? [anchor[0] - (bounds.x + bounds.width / 2), anchor[1] - (bounds.y + bounds.height / 2)] : [0, 0]
  const positioned = translateItems(copied, new Set(copied.map((stroke) => stroke.id)), delta)
  const inserted = withNewIds(positioned)
  return { items: [...items, ...inserted], insertedIds: inserted.map((stroke) => stroke.id) }
}

/** Duplicate the selected strokes with a small offset, as one edit. */
export function duplicateStrokes(items: BoardItem[], ids: readonly string[]): { items: BoardItem[]; insertedIds: string[] } {
  const copied = copySelectedStrokes(items, ids)
  const offset = translateItems(copied, new Set(copied.map((stroke) => stroke.id)), DUPLICATE_OFFSET)
  const inserted = withNewIds(offset)
  return { items: [...items, ...inserted], insertedIds: inserted.map((stroke) => stroke.id) }
}

export type BoardKeyAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete'

/** Map a key event to a board action. The caller rejects editable targets first. */
export function boardKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  options: { hasSelection: boolean; hasClipboard: boolean }
): BoardKeyAction | null {
  const key = event.key.toLowerCase()
  const modified = event.metaKey || event.ctrlKey
  if (event.altKey) return null
  if (modified && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (event.ctrlKey && key === 'y') return 'redo'
  if (modified && key === 'x') return options.hasSelection ? 'cut' : null
  if (modified && key === 'c') return options.hasSelection ? 'copy' : null
  if (modified && key === 'v') return options.hasClipboard ? 'paste' : null
  if (modified && key === 'd') return options.hasSelection ? 'duplicate' : null
  if (!modified && (event.key === 'Delete' || event.key === 'Backspace') && options.hasSelection) return 'delete'
  return null
}
