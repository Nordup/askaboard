import { afterEach, describe, expect, it } from 'vitest';
import type { Stroke } from '../types';
import { BoardHistory } from './history';
import { boardKeyAction, canHandleBoardShortcut, copySelectedStrokes, duplicateStrokes, hasInkClipboard, pasteStrokes, readInkClipboard, removeSelectedStrokes, writeInkClipboard } from './clipboard';

const ink: Stroke[] = [
  { id: 'one', tool: 'pen', color: '#6051DC', width: 5, points: [{ x: 10, y: 5, pressure: 0.35, time: 12 }, { x: 20, y: 15, pressure: 0.9, time: 13 }] },
  { id: 'two', tool: 'highlighter', color: '#E33E38', width: 20, points: [{ x: 80, y: 90, pressure: 1, time: 22 }] },
];

afterEach(() => writeInkClipboard([]));

describe('learner ink edit actions', () => {
  it('copies only selected strokes and preserves their complete drawing data', () => {
    const copied = copySelectedStrokes(ink, ['one']);
    expect(copied).toEqual([ink[0]]);
    expect(copied[0]).not.toBe(ink[0]);
    expect(copied[0].points[0]).not.toBe(ink[0].points[0]);
    expect(removeSelectedStrokes(ink, ['one'])).toEqual([ink[1]]);
  });

  it('keeps an ink-only internal clipboard and pastes a fresh copy around the board anchor', () => {
    writeInkClipboard(copySelectedStrokes(ink, ['one']));
    const first = readInkClipboard();
    expect(hasInkClipboard()).toBe(true);
    first[0].points[0].x = -500;
    expect(readInkClipboard()[0].points[0].x).toBe(10);

    const pasted = pasteStrokes(ink, readInkClipboard(), [100, 200], () => 'pasted');
    expect(pasted.strokes).toHaveLength(3);
    expect(pasted.insertedIds).toEqual(['pasted']);
    expect(pasted.strokes[2]).toMatchObject({ id: 'pasted', tool: 'pen', color: '#6051DC', width: 5 });
    expect(pasted.strokes[2].points).toEqual([
      { x: 95, y: 195, pressure: 0.35, time: 12 },
      { x: 105, y: 205, pressure: 0.9, time: 13 },
    ]);
  });

  it('duplicates selected strokes as one undoable edit with new ids and a visible offset', () => {
    const duplicated = duplicateStrokes(ink, ['one'], () => 'copy-one');
    expect(duplicated.strokes).toHaveLength(3);
    expect(duplicated.insertedIds).toEqual(['copy-one']);
    expect(duplicated.strokes[2].points.map(({ x, y }) => [x, y])).toEqual([[30, 25], [40, 35]]);
    const history = new BoardHistory();
    history.record(ink);
    expect(history.undo(duplicated.strokes)).toEqual(ink);
    expect(history.availability).toEqual({ canUndo: false, canRedo: true });
  });

  it('maps board shortcuts and leaves copy/paste unavailable when their board state is empty', () => {
    const key = (key: string, flags: Partial<KeyboardEvent> = {}) => boardKeyAction({
      key, metaKey: false, ctrlKey: true, shiftKey: false, ...flags,
    }, { hasSelection: true, hasClipboard: true });
    expect(key('z')).toBe('undo');
    expect(key('z', { shiftKey: true })).toBe('redo');
    expect(key('y')).toBe('redo');
    expect(key('x')).toBe('cut');
    expect(key('c')).toBe('copy');
    expect(key('v')).toBe('paste');
    expect(key('d')).toBe('duplicate');
    expect(key('Delete')).toBe('delete');
    expect(boardKeyAction({ key: 'c', metaKey: true, ctrlKey: false, shiftKey: false }, { hasSelection: false, hasClipboard: false })).toBeNull();
    expect(boardKeyAction({ key: 'v', metaKey: true, ctrlKey: false, shiftKey: false }, { hasSelection: false, hasClipboard: false })).toBeNull();
  });

  it('does not let board shortcuts take focus from menus, controls, or the composer', () => {
    const target = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });
    expect(canHandleBoardShortcut(target('DIV'), true, false)).toBe(true);
    expect(canHandleBoardShortcut(target('DIV'), false, false)).toBe(false);
    expect(canHandleBoardShortcut(target('DIV'), true, true)).toBe(false);
    expect(canHandleBoardShortcut(target('DIV'), true, false, false)).toBe(false);
    expect(canHandleBoardShortcut(target('BUTTON'), true, false)).toBe(false);
    expect(canHandleBoardShortcut(target('TEXTAREA'), true, false)).toBe(false);
    expect(canHandleBoardShortcut(target('DIV', true), true, false)).toBe(false);
  });
});
