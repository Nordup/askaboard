import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ saved: new Map<string, unknown>(), put: vi.fn(), api: { save: vi.fn(), delete: vi.fn(), sessions: vi.fn(), workspace: vi.fn() } }));
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, message: string) { super(message); } },
  request: vi.fn(),
  api: state.api,
}));
vi.mock('./journal', () => ({ journal: {
  all: async () => [...state.saved.values()],
  put: (entry: { workspace: { id: string } }) => state.put(entry),
  delete: async (id: string) => { state.saved.delete(id); },
} }));

import { ApiError } from '../api/client';
import { WorkspaceStore } from './store';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

describe('workspace persistence', () => {
  beforeEach(() => {
    state.saved.clear(); vi.resetAllMocks();
    state.put.mockImplementation(async (entry: { workspace: { id: string } }) => { state.saved.set(entry.workspace.id, structuredClone(entry)); });
    state.api.save.mockImplementation(async (workspace: { id: string }) => ({ workspace, revision: 1 }));
    state.api.delete.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('serializes local journal writes so an earlier snapshot cannot overwrite a later edit', async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void>();
    let calls = 0;
    state.put.mockImplementation(async (entry: { workspace: { id: string; title: string } }) => {
      calls++;
      if (calls === 1) await firstWrite.promise;
      state.saved.set(entry.workspace.id, structuredClone(entry));
    });
    const store = new WorkspaceStore();
    const original = store.create();
    store.patch(original.id, { title: 'Newest title' });
    const writes = (store as unknown as { journalWrites: Map<string, Promise<void>> }).journalWrites;
    const queued = writes.get(original.id)!;
    await Promise.resolve(); await Promise.resolve();
    expect(state.put).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await queued;
    expect(calls).toBe(2);
    expect((state.saved.get(original.id) as { workspace: { title: string } }).workspace.title).toBe('Newest title');
  });

  it('restores unsynced edits after an offline reload without attempting a server write', async () => {
    const offline = new WorkspaceStore();
    const original = offline.create();
    offline.patch(original.id, { title: 'Saved locally', scene: { elements: [{ id: 'shape-1', kind: 'line' }] } });
    await (offline as unknown as { journalWrites: Map<string, Promise<void>> }).journalWrites.get(original.id);

    const reloaded = new WorkspaceStore();
    await reloaded.initialize();
    expect(reloaded.active?.title).toBe('Saved locally');
    expect(reloaded.active?.scene.elements[0].id).toBe('shape-1');
    expect(reloaded.entries.get(original.id)?.dirty).toBe(true);
    await reloaded.flush(original.id);
    expect(state.api.save).not.toHaveBeenCalled();
  });

  it('serializes server saves and sends edits made during a save in a follow-up revision', async () => {
    const firstSave = deferred<{ workspace: { id: string }; revision: number }>();
    state.api.save.mockImplementationOnce(() => firstSave.promise).mockImplementation(async (workspace: { id: string }) => ({ workspace, revision: 2 }));
    const store = new WorkspaceStore(); store.authenticated = true;
    const original = store.create();
    const firstFlush = store.flush(original.id);
    await nextTurn();
    expect(state.api.save).toHaveBeenCalledOnce();
    store.patch(original.id, { title: 'Edit during request' });
    const queuedFlush = store.flush(original.id);
    firstSave.resolve({ workspace: original, revision: 1 });
    await Promise.all([firstFlush, queuedFlush]);
    expect(state.api.save).toHaveBeenCalledTimes(2);
    expect(state.api.save.mock.calls[1][0].title).toBe('Edit during request');
    expect(state.api.save.mock.calls[1][1]).toBe(1);
  });

  it('preserves a conflict in a fresh session without changing the original or reusing message IDs', async () => {
    state.api.save.mockRejectedValueOnce(new ApiError(409, 'revision conflict'));
    const store = new WorkspaceStore(); store.authenticated = true;
    const original = store.create();
    store.patch(original.id, { messages: [{ id: 'message-1', role: 'user', text: 'Keep me' }] });
    await store.flush(original.id);
    expect(store.sync).toBe('conflict');
    const before = structuredClone(store.entries.get(original.id)!.workspace);
    const copy = store.preserveConflict(original.id)!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.messages[0].id).not.toBe('message-1');
    expect(store.entries.get(original.id)!.workspace).toEqual(before);
    expect(store.activeId).toBe(copy.id);
    await store.flush(copy.id);
    expect(state.api.save.mock.calls[1][0].id).toBe(copy.id);
    expect(state.api.save.mock.calls[1][1]).toBe(0);
    expect(store.entries.has(original.id)).toBe(true);
    expect(store.error).toContain(copy.title);
  });
});
