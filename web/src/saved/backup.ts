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

/** A stored GPX track that looks right. */
export function isTrack(v: unknown): v is StoredTrack {
  const t = v as StoredTrack;
  return !!t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.color === 'string' && typeof t.visible === 'boolean'
    && isNum(t.added) && !!t.stats && !!t.gpx && Array.isArray(t.gpx.lines) && Array.isArray(t.gpx.waypoints);
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
