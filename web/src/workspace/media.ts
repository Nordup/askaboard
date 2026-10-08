/** Large image payloads live in their own IndexedDB store, never in a workspace save. */
const DATABASE = 'math-tutor-media-v1';
const STORE = 'media';
const FALLBACK = new Map<string, string>();

export function mediaKey(sessionId: string, imageId: string): string {
  return `${sessionId}:${imageId}`;
}

let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Image storage is unavailable in this browser.'));
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open image storage.'));
    request.onblocked = () => reject(new Error('Image storage is busy in another tab.'));
  }).catch(error => { database = null; throw error; });
  return database;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Image storage failed.'));
  });
}

export async function saveMedia(sessionId: string, imageId: string, base64: string): Promise<void> {
  const key = mediaKey(sessionId, imageId);
  if (typeof indexedDB === 'undefined') { FALLBACK.set(key, base64); return; }
  const db = await openDatabase();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(base64, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not save image.'));
    tx.onabort = () => reject(tx.error ?? new Error('Image save was cancelled.'));
  });
}

export async function loadMedia(sessionId: string, imageId: string): Promise<string | null> {
  const key = mediaKey(sessionId, imageId);
  if (typeof indexedDB === 'undefined') return FALLBACK.get(key) ?? null;
  const db = await openDatabase();
  return (await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) ?? null;
}

export async function deleteMedia(sessionId: string, imageId: string): Promise<void> {
  const key = mediaKey(sessionId, imageId);
  FALLBACK.delete(key);
  if (typeof indexedDB === 'undefined') return;
  const db = await openDatabase();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not delete image.'));
    tx.onabort = () => reject(tx.error ?? new Error('Image deletion was cancelled.'));
  });
}

export function mediaDataUrl(base64: string, mime = 'image/png'): string {
  return base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`;
}
