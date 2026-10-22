import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ saved: new Map<string, unknown>(), put: vi.fn(), lastOpened: null as string | null, deletedIds: [] as string[], api: { save: vi.fn(), delete: vi.fn(), sessions: vi.fn(), workspace: vi.fn() } }));
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, message: string) { super(message); } },
  request: vi.fn(),
  api: state.api,
}));
vi.mock('./journal', () => ({ journal: {
  all: async () => [...state.saved.values()],
  put: (entry: { workspace: { id: string } }) => state.put(entry),
  delete: async (id: string) => { state.saved.delete(id); },
  getLastOpened: async () => state.lastOpened,
  setLastOpened: async (id: string | null) => { state.lastOpened = id; },
  getDeletedIds: async () => [...state.deletedIds],
  setDeletedIds: async (ids: string[]) => { state.deletedIds = [...ids]; },
} }));

import { ApiError } from '../api/client';
import { WorkspaceStore } from './store';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
const localWrites = (store: WorkspaceStore) => (store as unknown as { journalWrites: Map<string, Promise<void>> }).journalWrites;

describe('workspace persistence', () => {
  beforeEach(() => {
    state.saved.clear(); state.lastOpened = null; state.deletedIds = []; vi.resetAllMocks();
    state.put.mockImplementation(async (entry: { workspace: { id: string } }) => { state.saved.set(entry.workspace.id, structuredClone(entry)); });
    state.api.save.mockImplementation(async (workspace: { id: string }) => ({ workspace, revision: 1 }));
    state.api.delete.mockResolvedValue(undefined);
    state.api.sessions.mockResolvedValue([]);
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
    store.patch(original.id, { customTitle: 'Newest title' });
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
    offline.patch(original.id, { customTitle: 'Saved locally', scene: { elements: [{ id: 'shape-1', kind: 'line', x1: 0, y1: 0, x2: 12, y2: 12 }] } });
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
    store.patch(original.id, { customTitle: 'Edit during request' });
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

  it('restores the last opened session even when another session was saved more recently', async () => {
    const store = new WorkspaceStore();
    const earlier = store.create();
    await localWrites(store).get(earlier.id);
    const later = store.create();
    await localWrites(store).get(later.id);
    state.lastOpened = earlier.id;

    const reloaded = new WorkspaceStore();
    await reloaded.initialize();
    expect(reloaded.activeId).toBe(earlier.id);
    expect(reloaded.active?.id).toBe(earlier.id);
  });

  it('does not move a session forward or dirty it when only the camera changes', async () => {
    const store = new WorkspaceStore();
    const workspace = store.create();
    const before = workspace.updatedAt;
    await localWrites(store).get(workspace.id);

    store.patch(workspace.id, { camera: { center: [420, -180], zoom: 1.4 } });
    expect(store.active?.camera).toEqual({ center: [420, -180], zoom: 1.4 });
    expect(store.active?.updatedAt).toBe(before);
    expect(store.entries.get(workspace.id)?.dirty).toBe(true);
    const revision = store.entries.get(workspace.id)?.revision;
    store.patch(workspace.id, { camera: { center: [420, -180], zoom: 1.4 } });
    expect(store.entries.get(workspace.id)?.revision).toBe(revision);
  });

  it('starts new sessions with defaults and reset removes only the active session', async () => {
    const store = new WorkspaceStore();
    const kept = store.create();
    store.patch(kept.id, { customTitle: 'Keep this', model: 'gpt-custom', reasoningEffort: 'medium' });
    const active = store.create();
    expect(store.active?.model).toBe('gpt-5.6-luna');
    expect(store.active?.reasoningEffort).toBe('high');

    const fresh = await store.reset(active.id);
    expect(store.entries.has(active.id)).toBe(false);
    expect(store.entries.get(kept.id)?.workspace).toMatchObject({ title: 'Keep this', model: 'gpt-custom', reasoningEffort: 'medium' });
    expect(fresh.model).toBe('gpt-5.6-luna');
    expect(fresh.reasoningEffort).toBe('high');
    expect(store.activeId).toBe(fresh.id);
  });

  it('keeps an offline delete tombstone so a remote session cannot reappear on refresh', async () => {
    const store = new WorkspaceStore();
    store.authenticated = true;
    const workspace = store.create();
    await localWrites(store).get(workspace.id);
    state.api.delete.mockRejectedValue(new Error('offline'));
    state.api.sessions.mockResolvedValue([{ id: workspace.id, title: 'Resurrect me', started_at: '2026-01-01T00:00:00Z' }]);

    await store.remove(workspace.id);
    expect(state.deletedIds).toContain(workspace.id);
    expect(state.saved.has(workspace.id)).toBe(false);
    await store.refresh();
    expect(store.entries.has(workspace.id)).toBe(false);
    expect(state.deletedIds).toContain(workspace.id);
  });
});
