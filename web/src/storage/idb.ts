/** The app's IndexedDB database (GPX tracks and saved pins and routes), kept on this device and
 *  independent of the loaded map. Every store is created here, so each module opens the same
 *  version. */
const DB = 'garmin-map';
const VERSION = 2;
export type StoreName = 'tracks' | 'saved';
const STORES: StoreName[] = ['tracks', 'saved'];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser cannot store data.'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open storage.'));
  });
}

/** Runs one request on `store` in its own transaction and resolves when the transaction completes. */
export async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Storage failed.'));
    });
  } finally {
    db.close();
  }
}
