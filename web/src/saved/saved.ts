import type { LonLat, RouteReply } from '../routing/plan';
import { run } from '../storage/idb';

/** The route as drawn when it was saved (what `planRoute` returned). */
export type RouteOk = Extract<RouteReply, { status: 'ok' }>;

interface Common {
  id: string;
  name: string;
  /** When it was saved (ms): the list order. */
  added: number;
}

export interface SavedPin extends Common {
  kind: 'pin';
  lon: number;
  lat: number;
}

/** A route as drawn, with where it went, where it started and the switches it was planned with. */
export interface SavedRoute extends Common {
  kind: 'route';
  dest: { name: string | null; lon: number; lat: number };
  from: LonLat;
  allowFRoads: boolean;
  preferFRoads: boolean;
  route: RouteOk;
}

export type Saved = SavedPin | SavedRoute;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLonLat = (v: unknown): v is LonLat => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isLine = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && v.every(isLonLat);

/** A stored item that looks right (an older or damaged entry is left out of the list). */
export function isSaved(v: unknown): v is Saved {
  const s = v as Saved;
  if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || !isNum(s.added)) return false;
  if (s.kind === 'pin') return isNum(s.lon) && isNum(s.lat);
  if (s.kind !== 'route') return false;
  const r = s.route;
  return !!s.dest && isNum(s.dest.lon) && isNum(s.dest.lat) && isLonLat(s.from) && typeof s.allowFRoads === 'boolean' && typeof s.preferFRoads === 'boolean'
    && !!r && r.status === 'ok' && isLine(r.coords) && isNum(r.metres) && isNum(r.seconds);
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const listSaved = async (): Promise<Saved[]> =>
  (await run('saved', 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>)).filter(isSaved).sort((a, b) => a.added - b.added);

export const putSaved = (item: Saved): Promise<unknown> => run('saved', 'readwrite', (s) => s.put(item));

export const deleteSaved = (id: string): Promise<unknown> => run('saved', 'readwrite', (s) => s.delete(id));
