import type { StoredTrack } from '../gpx/store';
import { changedAt, makeBackup, type Backup } from '../saved/backup';
import type { Saved } from '../saved/saved';

/** What this device holds. */
export interface Local {
  saved: Saved[];
  tracks: StoredTrack[];
  deleted: Record<string, number>;
}

/** The outcome of comparing this device with the synced file: what to change here, and the file
 *  to write back when it differs from what's there. */
export interface SyncPlan {
  putSaved: Saved[];
  putTracks: StoredTrack[];
  removeSaved: string[];
  removeTracks: string[];
  /** Deletions known on either side (the newer time for an id deleted on both). */
  deleted: Record<string, number>;
  /** The merged data to upload, or null when the file already holds it. */
  upload: Backup | null;
}

type Item = { id: string; added: number; updated?: number };

/** One kind of item: for each id, the copy changed last wins, unless the item was deleted after
 *  that change. */
function mergeKind<T extends Item>(mine: T[], theirs: T[], deleted: Record<string, number>) {
  const local = new Map(mine.map((x) => [x.id, x]));
  const remote = new Map(theirs.map((x) => [x.id, x]));
  const kept: T[] = [];
  const put: T[] = [];
  const remove: string[] = [];
  let remoteDiffers = false;
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(id);
    const r = remote.get(id);
    const win = !l ? r! : !r ? l : changedAt(r) > changedAt(l) ? r : l;
    const gone = deleted[id] !== undefined && deleted[id] >= changedAt(win);
    if (gone) {
      if (l) remove.push(id);
      if (r) remoteDiffers = true;
      continue;
    }
    kept.push(win);
    if (win !== l) put.push(win);
    if (win !== r && (!r || changedAt(win) !== changedAt(r))) remoteDiffers = true;
  }
  return { kept: kept.sort((a, b) => a.added - b.added), put, remove, remoteDiffers };
}

export function planSync(local: Local, remote: Backup | null, now = new Date()): SyncPlan {
  const deleted: Record<string, number> = { ...(remote?.deleted ?? {}) };
  for (const [id, at] of Object.entries(local.deleted)) deleted[id] = Math.max(at, deleted[id] ?? 0);
  const saved = mergeKind(local.saved, remote?.saved ?? [], deleted);
  const tracks = mergeKind(local.tracks, remote?.tracks ?? [], deleted);
  const theirDeleted = remote?.deleted ?? {};
  const deletedDiffers = Object.keys(deleted).length !== Object.keys(theirDeleted).length || Object.entries(deleted).some(([id, at]) => theirDeleted[id] !== at);
  const upload = !remote || saved.remoteDiffers || tracks.remoteDiffers || deletedDiffers ? makeBackup(saved.kept, tracks.kept, deleted, now) : null;
  return { putSaved: saved.put, putTracks: tracks.put, removeSaved: saved.remove, removeTracks: tracks.remove, deleted, upload };
}
