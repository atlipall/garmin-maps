import type { Gpx } from './parse';
import type { GpxStats } from './stats';
import type { RoadSeg } from '../routing/plan';
import { run } from '../storage/idb';

/** A track saved from a planned route: its road stretches (indexes into the first line's points),
 *  so navigating it gives the route's turn instructions, and the route's driving time. */
export interface TrackRoute {
  segs: RoadSeg[];
  seconds: number;
}

/** An imported GPX file as kept on this device (IndexedDB), independent of the loaded map. */
export interface StoredTrack {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /** When it was imported (ms): the list order. */
  added: number;
  /** When it was last changed (ms; shown or hidden, climb filled in), for syncing. */
  updated?: number;
  stats: GpxStats;
  gpx: Gpx;
  /** Saved from a planned route (else imported from a GPX file). */
  route?: TrackRoute;
}

export const listTracks = async (): Promise<StoredTrack[]> =>
  (await run('tracks', 'readonly', (s) => s.getAll() as IDBRequest<StoredTrack[]>)).sort((a, b) => a.added - b.added);

export const putTrack = (t: StoredTrack): Promise<unknown> => run('tracks', 'readwrite', (s) => s.put(t));

export const deleteTrack = (id: string): Promise<unknown> => run('tracks', 'readwrite', (s) => s.delete(id));
