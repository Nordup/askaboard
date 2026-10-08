import type { Point, Stroke } from '../types';
import { strokeBounds, translateStrokes, unionRegions } from './geometry';

const DUPLICATE_OFFSET: Point = [20, 20];
let internalClipboard: Stroke[] = [];

/** The portable clipboard contains learner ink only and can cross sessions. */
export function writeInkClipboard(strokes: Stroke[]): void {
  internalClipboard = structuredClone(strokes);
}

export function readInkClipboard(): Stroke[] {
  return structuredClone(internalClipboard);
}

export function hasInkClipboard(): boolean {
  return internalClipboard.length > 0;
}

export function copySelectedStrokes(strokes: Stroke[], ids: string[]): Stroke[] {
  const selected = new Set(ids);
  return structuredClone(strokes.filter(stroke => selected.has(stroke.id)));
}

export function removeSelectedStrokes(strokes: Stroke[], ids: string[]): Stroke[] {
  const selected = new Set(ids);
  return strokes.filter(stroke => !selected.has(stroke.id));
}

/** Paste copies around an explicit logical anchor, or the current board center. */
export function pasteStrokes(
  strokes: Stroke[],
  copied: Stroke[],
  anchor: Point,
  idFor: () => string = () => crypto.randomUUID(),
): { strokes: Stroke[]; insertedIds: string[] } {
  if (!copied.length) return { strokes, insertedIds: [] };
  const bounds = unionRegions(copied.map(strokeBounds));
  const delta: Point = bounds
    ? [anchor[0] - (bounds.x + bounds.width / 2), anchor[1] - (bounds.y + bounds.height / 2)]
    : [0, 0];
  const sourceIds = new Set(copied.map(stroke => stroke.id));
  const positioned = translateStrokes(copied, sourceIds, delta);
  const inserted = positioned.map(stroke => ({ ...stroke, id: idFor() }));
  return { strokes: [...strokes, ...inserted], insertedIds: inserted.map(stroke => stroke.id) };
}

/** Duplicate selected learner ink as one visible edit transaction. */
export function duplicateStrokes(
  strokes: Stroke[],
  ids: string[],
  idFor: () => string = () => crypto.randomUUID(),
): { strokes: Stroke[]; insertedIds: string[] } {
  const copied = copySelectedStrokes(strokes, ids);
  const sourceIds = new Set(copied.map(stroke => stroke.id));
  const offset = translateStrokes(copied, sourceIds, DUPLICATE_OFFSET);
  const inserted = offset.map(stroke => ({ ...stroke, id: idFor() }));
  return { strokes: [...strokes, ...inserted], insertedIds: inserted.map(stroke => stroke.id) };
}

export type BoardKeyAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete';

/** Board commands only run when the board itself owns focus. */
export function canHandleBoardShortcut(target: { tagName: string; isContentEditable: boolean }, boardIsFocused: boolean, menuOpen: boolean, boardVisible = true): boolean {
  if (!boardIsFocused || menuOpen || !boardVisible || target.isContentEditable) return false;
  return !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
}

/** Map shortcuts only after the focused board has rejected editable targets. */
export function boardKeyAction(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>, options: {
  hasSelection: boolean;
  hasClipboard: boolean;
}): BoardKeyAction | null {
  const key = event.key.toLowerCase(), modified = event.metaKey || event.ctrlKey;
  if (modified && key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (event.ctrlKey && key === 'y') return 'redo';
  if (modified && key === 'x') return options.hasSelection ? 'cut' : null;
  if (modified && key === 'c') return options.hasSelection ? 'copy' : null;
  if (modified && key === 'v') return options.hasClipboard ? 'paste' : null;
  if (modified && key === 'd') return options.hasSelection ? 'duplicate' : null;
  if ((event.key === 'Delete' || event.key === 'Backspace') && options.hasSelection) return 'delete';
  return null;
}
