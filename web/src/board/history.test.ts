import { describe, expect, it } from 'vitest';
import type { Stroke } from '../types';
import { BoardHistory } from './history';

const stroke = (id: string): Stroke => ({
  id, tool: 'pen', color: '#0A0A0A', width: 5,
  points: [{ x: 1, y: 2, pressure: 1, time: 1 }],
});

describe('board ink history', () => {
  it('restores whole stroke snapshots and moves them between undo and redo', () => {
    const history = new BoardHistory();
    const empty: Stroke[] = [];
    const written = [stroke('a')];
    history.record(empty);

    expect(history.availability).toEqual({ canUndo: true, canRedo: false });
    expect(history.undo(written)).toEqual(empty);
    expect(history.availability).toEqual({ canUndo: false, canRedo: true });
    expect(history.redo(empty)).toEqual(written);
    expect(history.availability).toEqual({ canUndo: true, canRedo: false });
  });

  it('starts a new history branch after undo and never changes prior snapshots', () => {
    const history = new BoardHistory();
    const first = [stroke('a')];
    const second = [stroke('a'), stroke('b')];
    const third = [stroke('a'), stroke('c')];
    history.record([]);
    history.record(first);
    expect(history.undo(second)).toEqual(first);
    history.record(first);

    expect(history.redo(first)).toBeNull();
    expect(history.undo(third)).toEqual(first);
    expect(second.map(item => item.id)).toEqual(['a', 'b']);
    expect(first.map(item => item.id)).toEqual(['a']);
  });

  it('keeps the newest bounded snapshots and clears both directions on reset', () => {
    const history = new BoardHistory(2);
    const a = [stroke('a')];
    const b = [stroke('a'), stroke('b')];
    const c = [stroke('a'), stroke('b'), stroke('c')];
    history.record([]);
    history.record(a);
    history.record(b);
    history.undo(c);
    expect(history.undo(b)).toEqual(a);
    expect(history.undo(a)).toBeNull();

    history.clear();
    expect(history.availability).toEqual({ canUndo: false, canRedo: false });
  });
});
