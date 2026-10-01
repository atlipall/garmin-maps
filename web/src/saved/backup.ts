import type { StoredTrack } from '../gpx/store';
import { isSaved, type Saved } from './saved';

/** A backup of everything the user keeps on the device besides the map: saved pins and routes,
 *  and GPX tracks. Also the shape of the Google Drive sync file (with deletions). */
export interface Backup {
  app: 'garmin-map';
  kind: 'backup';
  version: 1;
  /** When it was written (ISO time). */
  exported: string;
  saved: Saved[];
  tracks: StoredTrack[];
  /** Deleted items: id → when (ms), so a deletion reaches other devices when syncing. */
  deleted?: Record<string, number>;
}

/** An item's last change (ms): when it was last edited, else when it was added. */
export const changedAt = (x: { added: number; updated?: number }) => x.updated ?? x.added;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';
const isPoint = (p: unknown) => {
  const q = p as { lon: unknown; lat: unknown; ele?: unknown; time?: unknown };
  return !!q && isNum(q.lon) && isNum(q.lat) && Math.abs(q.lat) <= 90 && Math.abs(q.lon) <= 180
    && (q.ele === undefined || q.ele === null || isNum(q.ele)) && (q.time === undefined || q.time === null || isNum(q.time));
};
/** A track colour as the app makes them (#rrggbb): anything else (a url(), say) would be fetched
 *  when the colour is used. */
export const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** A stored GPX track that looks right, all the way down to its points (one that isn't would break
 *  the Tracks panel on every synced device). */
export function isTrack(v: unknown): v is StoredTrack {
  const t = v as StoredTrack;
  if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || !isColor(t.color) || typeof t.visible !== 'boolean' || !isNum(t.added)) return false;
  if (t.updated !== undefined && !isNum(t.updated)) return false;
  const s = t.stats;
  if (!s || !isNum(s.distance) || !(s.climb === null || isNum(s.climb)) || !(s.duration === null || isNum(s.duration))) return false;
  const g = t.gpx;
  return !!g && isStrOrNull(g.name) && Array.isArray(g.lines) && Array.isArray(g.waypoints)
    && g.lines.every((l) => !!l && (l.kind === 'track' || l.kind === 'route') && isStrOrNull(l.name) && Array.isArray(l.points) && l.points.every(isPoint))
    && g.waypoints.every((w) => isPoint(w) && isStrOrNull(w.name));
}

export function makeBackup(saved: Saved[], tracks: StoredTrack[], deleted: Record<string, number> = {}, now = new Date()): Backup {
  return { app: 'garmin-map', kind: 'backup', version: 1, exported: now.toISOString(), saved, tracks, deleted };
}

/** A backup file's contents; throws with a message for the user when it isn't one. Items that
 *  don't look right are left out. */
export function parseBackup(text: string): Backup {
  let b: Backup;
  try {
    b = JSON.parse(text);
  } catch {
    throw new Error("This isn't a Garmin Map backup file.");
  }
  if (!b || b.app !== 'garmin-map' || b.kind !== 'backup') throw new Error("This isn't a Garmin Map backup file.");
  if (b.version !== 1) throw new Error('This backup is from a newer version of the app.');
  const deleted: Record<string, number> = {};
  for (const [id, at] of Object.entries(b.deleted ?? {})) if (isNum(at)) deleted[id] = at;
  return {
    ...b,
    saved: Array.isArray(b.saved) ? b.saved.filter(isSaved) : [],
    tracks: Array.isArray(b.tracks) ? b.tracks.filter(isTrack) : [],
    deleted,
  };
}

/** The incoming items to store here: those this device doesn't have, and those changed later than
 *  its copy. With `deleted`, an item deleted after its last change is left out. */
export function toStore<T extends { id: string; added: number; updated?: number }>(local: T[], incoming: T[], deleted: Record<string, number> = {}): T[] {
  const mine = new Map(local.map((x) => [x.id, x]));
  return incoming.filter((x) => {
    const gone = deleted[x.id];
    if (gone !== undefined && gone >= changedAt(x)) return false;
    const m = mine.get(x.id);
    return !m || changedAt(x) > changedAt(m);
  });
}

export const backupFileName = (now = new Date()) => `Garmin Map backup ${now.toISOString().slice(0, 10)}.json`;
