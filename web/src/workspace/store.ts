import { api, ApiError, request } from '../api/client';
import type { Workspace } from '../types';
import { journal, type JournalEntry } from './journal';

export function blankWorkspace(id: string = crypto.randomUUID()): Workspace {
  return { version: 1, id, title: 'New session', strokes: [], scene: { elements: [] }, camera: { center: [0, 0], zoom: 1 },
    messages: [], model: 'gpt-5.6-luna', reasoningEffort: 'high', plan: null, exercise: null, updatedAt: new Date().toISOString() };
}
export type SyncState = 'saved' | 'saving' | 'local' | 'conflict' | 'error';
export class WorkspaceStore {
  entries = new Map<string, JournalEntry>();
  activeId: string | null = null;
  authenticated = false;
  sync: SyncState = 'local';
  error: string | null = null;
  private listeners = new Set<() => void>();
  private saves = new Map<string, Promise<void>>();
  private journalWrites = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private conflicts = new Set<string>();
  private preservedConflicts = new Set<string>();
  private deleting = new Set<string>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  notify() { this.listeners.forEach(l => l()); }
  get active() { return this.activeId ? this.entries.get(this.activeId)?.workspace ?? null : null; }
  get conflictId() {
    if (this.activeId && this.conflicts.has(this.activeId) && !this.preservedConflicts.has(this.activeId)) return this.activeId;
    return [...this.conflicts].find(id => !this.preservedConflicts.has(id)) ?? null;
  }
  async initialize() {
    try { for (const entry of await journal.all()) this.entries.set(entry.workspace.id, entry); }
    catch { this.error = 'Browser storage is unavailable. Keep this page open until server saving is available.'; }
    this.activeId = [...this.entries.values()].sort((a, b) => b.workspace.updatedAt.localeCompare(a.workspace.updatedAt))[0]?.workspace.id ?? null;
    this.notify();
  }
  async refresh() {
    if (!this.authenticated) return;
    const sessions = await api.sessions();
    for (const session of sessions) {
      const id = String(session.id);
      if (!this.entries.has(id)) {
        const workspace = { ...blankWorkspace(id), title: typeof session.title === 'string' ? session.title : 'Learning session',
          updatedAt: String(session.updated_at ?? new Date().toISOString()), model: String(session.model), reasoningEffort: String(session.reasoning_effort) };
        this.entries.set(id, { workspace, revision: -1, dirty: false });
      }
    }
    if (!this.activeId) this.activeId = sessions[0] ? String(sessions[0].id) : null;
    this.notify();
    if (this.activeId) await this.open(this.activeId);
    for (const [id, entry] of this.entries) if (entry.dirty) void this.flush(id);
  }
  create() {
    const workspace = blankWorkspace(); this.activeId = workspace.id;
    this.entries.set(workspace.id, { workspace, revision: 0, dirty: true });
    this.changed(workspace.id); return workspace;
  }
  patch(id: string, patch: Partial<Workspace>) {
    if (this.deleting.has(id)) return;
    if (this.conflicts.has(id) && this.preservedConflicts.has(id)) this.preservedConflicts.delete(id);
    const entry = this.entries.get(id); if (!entry) return;
    const cameraOnly = Object.keys(patch).every(key => key === 'camera');
    entry.workspace = { ...entry.workspace, ...patch, id, updatedAt: cameraOnly ? entry.workspace.updatedAt : new Date().toISOString() };
    entry.dirty = true; this.changed(id);
  }
  private changed(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    this.sync = this.authenticated ? 'saving' : 'local';
    void this.persist(entry).catch(() => { this.error = 'Local save failed. Check available browser storage.'; this.notify(); });
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { void this.flush(id); }, 650));
    this.notify();
  }
  /** Queue the newest local snapshots for IndexedDB before a reload or tab close. */
  pageHide() {
    for (const [id, entry] of this.entries) {
      clearTimeout(this.timers.get(id)); this.timers.delete(id);
      void this.persist(entry).catch(() => { this.error = 'Local save failed. Check available browser storage.'; });
    }
  }
  private persist(entry: JournalEntry) {
    const id = entry.workspace.id;
    const snapshot = structuredClone(entry);
    const previous = this.journalWrites.get(id);
    const write = (previous ?? Promise.resolve()).catch(() => undefined)
      .then(() => journal.put(snapshot)).then(() => undefined);
    this.journalWrites.set(id, write);
    void write.finally(() => { if (this.journalWrites.get(id) === write) this.journalWrites.delete(id); }).catch(() => undefined);
    return write;
  }
  async open(id: string) {
    if (this.activeId && this.activeId !== id) await this.flush(this.activeId);
    this.activeId = id; this.notify();
    const local = this.entries.get(id);
    if (!this.authenticated || local?.dirty) return;
    try {
      const remote = await api.workspace(id);
      // A board edit made while hydration was in flight wins locally.
      if (this.entries.get(id)?.dirty) return;
      this.entries.set(id, { ...remote, dirty: false });
      await this.persist({ ...remote, dirty: false });
      this.sync = this.conflicts.size ? 'conflict' : 'saved';
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        const session = await request<Record<string, unknown>>(`/v1/sessions/${id}`);
        const w = local?.workspace ?? blankWorkspace(id);
        const rows = Array.isArray(session.messages) ? session.messages : [];
        w.messages = rows.filter(m => m.role === 'learner' || m.role === 'tutor').map(m => ({ id: String(m.id), role: m.role === 'learner' ? 'user' : 'assistant', text: String(m.text) }));
        this.entries.set(id, { workspace: w, revision: 0, dirty: false });
      } else this.error = error instanceof Error ? error.message : 'Could not open the session.';
    }
    this.notify();
  }
  async flush(id = this.activeId ?? '') {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    if (!this.authenticated || this.conflicts.has(id)) return;
    const running = this.saves.get(id);
    if (running) { await running; if (this.entries.get(id)?.dirty) await this.flush(id); return; }
    const entry = this.entries.get(id); if (!entry?.dirty) return;
    const sent = structuredClone(entry.workspace); const revision = Math.max(0, entry.revision);
    const saving = (async () => {
      this.sync = 'saving'; this.notify();
      try {
        const result = await api.save(sent, revision);
        const current = this.entries.get(id);
        if (!current) return;
        current.revision = result.revision;
        // Never replace newer in-flight edits with the request's older save.
        current.dirty = JSON.stringify(current.workspace) !== JSON.stringify(sent);
        await this.persist(current);
        this.sync = current.dirty ? 'saving' : 'saved';
        if (!this.conflicts.size) this.error = null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          this.conflicts.add(id); this.sync = 'conflict';
          this.error = 'This session changed in another tab. Your edits are kept in this browser. Preserve a copy before reloading to keep them in a separate session.';
        } else {
          this.sync = 'local'; this.error = 'Server save is unavailable. Your work is kept in this browser.';
        }
      } finally { this.notify(); }
    })();
    this.saves.set(id, saving); await saving; this.saves.delete(id);
  }
  /** Creates a separate local/server session containing the conflicted edits. The original is untouched. */
  preserveConflict(id: string): Workspace | null {
    const source = this.entries.get(id);
    if (!source || !this.conflicts.has(id) || this.preservedConflicts.has(id)) return null;
    const workspace = structuredClone(source.workspace);
    workspace.id = crypto.randomUUID();
    const prefix = `Copy of ${source.workspace.title}`;
    workspace.title = prefix.slice(0, 255);
    workspace.updatedAt = new Date().toISOString();
    // Message IDs identify rows in the copied transcript. Provider conversation
    // IDs are deliberately never copied; they live only in the LiveCall transport.
    workspace.messages = workspace.messages.map(message => ({ ...message, id: crypto.randomUUID() }));
    const copy: JournalEntry = { workspace, revision: 0, dirty: true };
    this.entries.set(workspace.id, copy);
    this.preservedConflicts.add(id);
    this.activeId = workspace.id;
    this.changed(workspace.id);
    this.error = `Your edits were copied to “${workspace.title}”. The original session is unchanged.`;
    this.notify();
    return workspace;
  }
  async remove(id: string) {
    if (this.deleting.has(id)) return;
    this.deleting.add(id);
    try {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    if (this.entries.get(id)?.dirty && this.authenticated && !this.conflicts.has(id)) await this.flush(id);
    await this.saves.get(id);
    await this.journalWrites.get(id);
    if (this.authenticated) await api.delete(id);
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.entries.delete(id); this.conflicts.delete(id); this.preservedConflicts.delete(id); await journal.delete(id);
    if (!this.conflicts.size && this.error?.includes('changed in another tab')) this.error = null;
    if (this.activeId === id) this.activeId = this.entries.keys().next().value ?? null;
    this.notify();
    } finally { this.deleting.delete(id); }
  }
}
