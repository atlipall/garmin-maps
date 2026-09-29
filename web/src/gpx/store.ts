import type { Gpx } from './parse';
import type { GpxStats } from './stats';

/** An imported GPX file as kept on this device (IndexedDB), independent of the loaded map. */
export interface StoredTrack {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /** When it was imported (ms): the list order. */
  added: number;
  stats: GpxStats;
  gpx: Gpx;
}

const DB = 'garmin-map';
const STORE = 'tracks';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser cannot store tracks.'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open track storage.'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Track storage failed.'));
    });
  } finally {
    db.close();
  }
}

export const listTracks = async (): Promise<StoredTrack[]> =>
  (await run('readonly', (s) => s.getAll() as IDBRequest<StoredTrack[]>)).sort((a, b) => a.added - b.added);

export const putTrack = (t: StoredTrack): Promise<unknown> => run('readwrite', (s) => s.put(t));

export const deleteTrack = (id: string): Promise<unknown> => run('readwrite', (s) => s.delete(id));
