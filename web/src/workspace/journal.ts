import type { Workspace } from '../types';

export interface JournalEntry { workspace: Workspace; revision: number; dirty: boolean; }
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('math-tutor-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('workspaces', { keyPath: 'workspace.id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = undefined; reject(r.error); };
  });
}
async function operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaces', mode);
    const r = run(tx.objectStore('workspaces')); let result: T;
    r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted.'));
  });
}
export const journal = {
  all: () => operation('readonly', s => s.getAll()) as Promise<JournalEntry[]>,
  put: (entry: JournalEntry) => operation('readwrite', s => s.put(entry)),
  delete: (id: string) => operation('readwrite', s => s.delete(id)),
};
