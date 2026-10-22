import { api, ApiError, request } from '../api/client';
import type { Workspace } from '../types';
import { journal, type JournalEntry } from './journal';
import { UNTITLED_SESSION, withDerivedTitle } from './title';

export function blankWorkspace(id: string = crypto.randomUUID()): Workspace {
  return { version: 1, id, title: UNTITLED_SESSION, customTitle: null, strokes: [], scene: { elements: [] }, camera: { center: [0, 0], zoom: 1 },
    messages: [], model: 'gpt-5.6-luna', reasoningEffort: 'high', plan: null, exercise: null, updatedAt: new Date().toISOString() };
}
/** Any workspace change except `title`, which is derived (see `./title`). */
export type WorkspacePatch = Partial<Omit<Workspace, 'title'>>;
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
  private deletedIds = new Set<string>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  notify() { this.listeners.forEach(l => l()); }
  get active() { return this.activeId ? this.entries.get(this.activeId)?.workspace ?? null : null; }
  get conflictId() {
    if (this.activeId && this.conflicts.has(this.activeId) && !this.preservedConflicts.has(this.activeId)) return this.activeId;
    return [...this.conflicts].find(id => !this.preservedConflicts.has(id)) ?? null;
  }
  async initialize() {
    try {
      for (const entry of await journal.all()) this.entries.set(entry.workspace.id, this.derivingTitle(entry));
      this.deletedIds = new Set(await journal.getDeletedIds());
      for (const id of this.deletedIds) this.entries.delete(id);
    }
    catch { this.error = 'Browser storage is unavailable. Keep this page open until server saving is available.'; }
    const remembered = await journal.getLastOpened().catch(() => null);
    this.activeId = remembered && this.entries.has(remembered)
      ? remembered
      : this.mostRecentId();
    if (this.activeId !== remembered) void journal.setLastOpened(this.activeId).catch(() => {
      this.error = 'The active session could not be remembered in browser storage.';
      this.notify();
    });
    this.notify();
  }
  async refresh() {
    if (!this.authenticated) return;
    await this.syncDeletedSessions();
    const sessions = await api.sessions();
    for (const session of sessions) {
      const id = String(session.id);
      if (this.deletedIds.has(id)) continue;
      if (!this.entries.has(id)) {
        // A summary only: the server's cached derived title stands until the
        // session is opened and its content can derive it again.
        const workspace = {
          ...blankWorkspace(id),
          customTitle: undefined,
          title: typeof session.title === 'string' && session.title.trim() ? session.title : UNTITLED_SESSION,
          updatedAt: this.sessionTimestamp(session),
          model: typeof session.model === 'string' ? session.model : blankWorkspace(id).model,
          reasoningEffort: typeof session.reasoning_effort === 'string' ? session.reasoning_effort : blankWorkspace(id).reasoningEffort,
        };
        this.entries.set(id, { workspace, revision: -1, dirty: false });
      }
    }
    if (!this.activeId || !this.entries.has(this.activeId)) {
      this.activeId = this.mostRecentId();
      await this.rememberActive(this.activeId);
    }
    this.notify();
    if (this.activeId) await this.open(this.activeId);
    for (const [id, entry] of this.entries) if (entry.dirty) void this.flush(id);
  }
  /** The entry on derived titles; dirty when that changed what was saved. */
  private derivingTitle(entry: JournalEntry): JournalEntry {
    // A server summary (revision -1) has no content to derive from and must
    // never be saved over the real workspace; its cached title stands.
    if (entry.revision < 0) return entry;
    const workspace = withDerivedTitle(entry.workspace);
    const changed = JSON.stringify(workspace) !== JSON.stringify(entry.workspace);
    return { ...entry, workspace, dirty: entry.dirty || changed };
  }
  private mostRecentId(): string | null {
    return [...this.entries.values()]
      .filter(entry => !this.deletedIds.has(entry.workspace.id))
      .sort((a, b) => b.workspace.updatedAt.localeCompare(a.workspace.updatedAt))[0]?.workspace.id ?? null;
  }
  private sessionTimestamp(session: Record<string, unknown>): string {
    for (const value of [session.updated_at, session.started_at]) {
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    }
    // A missing server clock must not make an old session look like the newest one.
    return '1970-01-01T00:00:00.000Z';
  }
  private async rememberActive(id: string | null) {
    try {
      const entry = id ? this.entries.get(id) : undefined;
      if (entry) {
        const pending = this.journalWrites.get(id!);
        if (pending) await pending;
        else await this.persist(entry);
      }
      await journal.setLastOpened(id);
    } catch {
      this.error = 'The active session could not be remembered in browser storage.';
      this.notify();
    }
  }
  private async syncDeletedSessions() {
    let changed = false;
    for (const id of this.deletedIds) {
      try { await api.delete(id); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) continue; }
      this.deletedIds.delete(id);
      changed = true;
    }
    if (changed) {
      try { await journal.setDeletedIds([...this.deletedIds]); }
      catch { this.error = 'A deleted session is still waiting to sync from this browser.'; }
    }
  }
  create() {
    const previousId = this.activeId;
    const workspace = blankWorkspace(); this.activeId = workspace.id;
    this.entries.set(workspace.id, { workspace, revision: 0, dirty: true });
    if (previousId && previousId !== workspace.id) void this.flush(previousId);
    this.changed(workspace.id);
    void this.rememberActive(workspace.id);
    return workspace;
  }
  async reset(id = this.activeId): Promise<Workspace> {
    if (id) await this.remove(id);
    return this.create();
  }
  patch(id: string, patch: WorkspacePatch) {
    if (this.deleting.has(id)) return;
    if (!Object.keys(patch).length) return;
    if (this.conflicts.has(id) && this.preservedConflicts.has(id)) this.preservedConflicts.delete(id);
    const entry = this.entries.get(id); if (!entry) return;
    const next = withDerivedTitle({ ...entry.workspace, ...patch, id });
    if (JSON.stringify(next) === JSON.stringify(entry.workspace)) return;
    const cameraOnly = Object.keys(patch).every(key => key === 'camera');
    entry.workspace = { ...next, updatedAt: cameraOnly ? entry.workspace.updatedAt : new Date().toISOString() };
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
    void this.rememberActive(id);
    const local = this.entries.get(id);
    if (!this.authenticated || local?.dirty) return;
    try {
      const remote = await api.workspace(id);
      // A board edit made while hydration was in flight wins locally.
      if (this.entries.get(id)?.dirty) return;
      const hydrated = this.derivingTitle({ ...remote, dirty: false });
      this.entries.set(id, hydrated);
      // A title derived differently from the saved one is saved back, so the
      // server's session list stops showing an older client's name.
      if (hydrated.dirty) this.changed(id); else await this.persist(hydrated);
      this.sync = this.conflicts.size ? 'conflict' : 'saved';
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        const session = await request<Record<string, unknown>>(`/v1/sessions/${id}`);
        const w = local?.workspace ?? blankWorkspace(id);
        const rows = Array.isArray(session.messages) ? session.messages : [];
        w.messages = rows.filter(m => m.role === 'learner' || m.role === 'tutor').map(m => ({ id: String(m.id), role: m.role === 'learner' ? 'user' : 'assistant', text: String(m.text) }));
        const restored = { workspace: withDerivedTitle(w), revision: 0, dirty: false };
        this.entries.set(id, restored);
        await this.persist(restored);
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
    workspace.customTitle = `Copy of ${source.workspace.title}`.slice(0, 255);
    Object.assign(workspace, withDerivedTitle(workspace));
    workspace.updatedAt = new Date().toISOString();
    // Message IDs identify rows in the copied transcript. Provider conversation
    // IDs are deliberately never copied; they live only in the LiveCall transport.
    workspace.messages = workspace.messages.map(message => ({ ...message, id: crypto.randomUUID() }));
    const copy: JournalEntry = { workspace, revision: 0, dirty: true };
    this.entries.set(workspace.id, copy);
    this.preservedConflicts.add(id);
    this.activeId = workspace.id;
    this.changed(workspace.id);
    void this.rememberActive(workspace.id);
    this.error = `Your edits were copied to “${workspace.title}”. The original session is unchanged.`;
    this.notify();
    return workspace;
  }
  async remove(id: string) {
    if (this.deleting.has(id)) return;
    this.deleting.add(id);
    try {
      const orderBeforeDelete = [...this.entries.values()]
        .filter(entry => !this.deletedIds.has(entry.workspace.id))
        .sort((a, b) => b.workspace.updatedAt.localeCompare(a.workspace.updatedAt))
        .map(entry => entry.workspace.id);
      const wasActive = this.activeId === id;
      clearTimeout(this.timers.get(id)); this.timers.delete(id);
      // Let a request already on the wire finish before the tombstone's DELETE.
      // Unsent edits are intentionally discarded with the session.
      await this.saves.get(id);
      await this.journalWrites.get(id);

      this.deletedIds.add(id);
      try { await journal.setDeletedIds([...this.deletedIds]); }
      catch { this.error = 'The delete could not be queued in browser storage.'; }
      this.entries.delete(id);
      this.conflicts.delete(id);
      this.preservedConflicts.delete(id);
      try { await journal.delete(id); }
      catch { this.error = 'The deleted session could not be removed from browser storage.'; }

      if (wasActive) {
        const index = orderBeforeDelete.indexOf(id);
        const below = index >= 0 ? orderBeforeDelete.slice(index + 1).find(candidate => this.entries.has(candidate)) : undefined;
        const above = index > 0 ? orderBeforeDelete.slice(0, index).reverse().find(candidate => this.entries.has(candidate)) : undefined;
        this.activeId = below ?? above ?? this.mostRecentId();
        await this.rememberActive(this.activeId);
      }
      if (!this.conflicts.size && this.error?.includes('changed in another tab')) this.error = null;
      this.notify();

      if (this.authenticated) {
        try { await api.delete(id); }
        catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) {
            this.error = 'The session was removed here and will be deleted from the server when it reconnects.';
            this.notify();
            return;
          }
        }
        this.deletedIds.delete(id);
        try { await journal.setDeletedIds([...this.deletedIds]); }
        catch { this.error = 'The delete finished on the server but could not be saved in browser storage.'; }
      }
      this.notify();
    } finally { this.deleting.delete(id); }
  }
}
