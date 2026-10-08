import type { Workspace } from '../types';

export interface JournalEntry { workspace: Workspace; revision: number; dirty: boolean; }
type JournalMeta =
  | { key: 'lastOpened'; value: string | null }
  | { key: 'deletedIds'; value: string[] };

const DATABASE_NAME = 'math-tutor-web';
const DATABASE_VERSION = 2;
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('workspaces')) {
        db.createObjectStore('workspaces', { keyPath: 'workspace.id' });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('Browser storage could not be opened.'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Browser storage is busy in another tab.'));
    };
  });
  opening = attempt;
  void attempt.catch(() => { if (opening === attempt) opening = undefined; });
  return attempt;
}

async function operation<T>(
  storeName: 'workspaces' | 'meta',
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let request: IDBRequest<T>;
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(storeName, mode);
      request = run(transaction.objectStore(storeName));
    } catch (error) {
      reject(error);
      return;
    }
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local save was interrupted.'));
  });
}

export const journal = {
  all: () => operation<JournalEntry[]>('workspaces', 'readonly', store => store.getAll()),
  put: (entry: JournalEntry) => operation<IDBValidKey>('workspaces', 'readwrite', store => store.put(entry)),
  delete: (id: string) => operation<undefined>('workspaces', 'readwrite', store => store.delete(id)),
  async getLastOpened(): Promise<string | null> {
    const value = await operation<Extract<JournalMeta, { key: 'lastOpened' }> | undefined>('meta', 'readonly', store => store.get('lastOpened'));
    return value?.value ?? null;
  },
  setLastOpened(id: string | null) {
    return operation<IDBValidKey>('meta', 'readwrite', store => store.put({ key: 'lastOpened', value: id } satisfies Extract<JournalMeta, { key: 'lastOpened' }>));
  },
  async getDeletedIds(): Promise<string[]> {
    const value = await operation<Extract<JournalMeta, { key: 'deletedIds' }> | undefined>('meta', 'readonly', store => store.get('deletedIds'));
    return value?.value ?? [];
  },
  setDeletedIds(ids: string[]) {
    return operation<IDBValidKey>('meta', 'readwrite', store => store.put({ key: 'deletedIds', value: ids } satisfies Extract<JournalMeta, { key: 'deletedIds' }>));
  },
};
