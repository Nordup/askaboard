import type { Stroke } from '../types';

export interface HistoryAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

/** Bounded snapshots for learner ink. Camera movement never enters this stack. */
export class BoardHistory {
  private past: Stroke[][] = [];
  private future: Stroke[][] = [];

  constructor(private readonly limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('History limit must be a positive integer.');
  }

  get availability(): HistoryAvailability {
    return { canUndo: this.past.length > 0, canRedo: this.future.length > 0 };
  }

  record(snapshot: Stroke[]): void {
    this.past.push([...snapshot]);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Stroke[]): Stroke[] | null {
    const snapshot = this.past.pop();
    if (!snapshot) return null;
    this.future.push([...current]);
    return [...snapshot];
  }

  redo(current: Stroke[]): Stroke[] | null {
    const snapshot = this.future.pop();
    if (!snapshot) return null;
    this.past.push([...current]);
    if (this.past.length > this.limit) this.past.shift();
    return [...snapshot];
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
