import type { Gpx } from './parse';
import type { GpxStats } from './stats';
import { run } from '../storage/idb';

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

export const listTracks = async (): Promise<StoredTrack[]> =>
  (await run('tracks', 'readonly', (s) => s.getAll() as IDBRequest<StoredTrack[]>)).sort((a, b) => a.added - b.added);

export const putTrack = (t: StoredTrack): Promise<unknown> => run('tracks', 'readwrite', (s) => s.put(t));

export const deleteTrack = (id: string): Promise<unknown> => run('tracks', 'readwrite', (s) => s.delete(id));
