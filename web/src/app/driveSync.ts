import { deleteTrack, listTracks, putTrack } from '../gpx/store';
import { deletions, setDeletions } from '../saved/deleted';
import { deleteSaved, listSaved, putSaved } from '../saved/saved';
import { deleteSyncFile, DriveError, readSyncFile, writeSyncFile } from '../sync/drive';
import { GOOGLE_CLIENT_ID, prepareSignIn, setSyncState, signIn, signOut, syncState, validToken } from '../sync/google';
import { planSync } from '../sync/merge';
import { changedAt } from '../saved/backup';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** A change here is synced this long after the last one (ms), so a burst of edits is one sync. */
const AFTER_CHANGE_MS = 3000;

const timeText = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Keeps saved pins and routes and GPX tracks the same on every device signed in to the same Google
 * account, through one file in the hidden app-data folder of the user's Google Drive. Syncs when the
 * app starts, comes back to the screen or back online, and a few seconds after a change here; the
 * copy changed last wins, and deletions carry over. Offered only when the app has a Google client ID.
 * Entirely optional: off until turned on, never loads anything from Google before that, and never
 * holds up the app — everything is read from and saved to the device first, offline or not.
 */
export class DriveSync {
  private running: Promise<void> | null = null;
  private again = false;
  private timer = 0;

  /** `reload` reads the saved items and tracks again after a sync changed them here. */
  constructor(private readonly reload: () => Promise<void>) {
    if (!GOOGLE_CLIENT_ID) return;
    $('sync').hidden = false;
    $('sync-connect').onclick = () => void this.connect();
    $('sync-now').onclick = () => void this.syncNow();
    $('sync-stop').onclick = () => {
      signOut();
      this.render();
    };
    this.render();
    if (syncState().on) {
      if (navigator.onLine) prepareSignIn().catch(() => {});
      void this.syncNow();
    }
    window.addEventListener('online', () => this.schedule(0));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.schedule(0));
  }

  /** Something changed here (saved, deleted, restored, a track shown or hidden): sync soon. */
  changed(): void {
    if (!GOOGLE_CLIENT_ID || !syncState().on) return;
    setSyncState({ ...syncState(), changedAt: Date.now() });
    this.schedule();
  }

  /** Sync soon (also on coming back to the app or online). */
  schedule(delay = AFTER_CHANGE_MS): void {
    if (!GOOGLE_CLIENT_ID || !syncState().on) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.syncNow(), delay);
  }

  /** Signs in (from a tap) and syncs. */
  private async connect(): Promise<void> {
    try {
      await prepareSignIn();
      await signIn();
      await this.syncNow();
    } catch (err) {
      this.render(err instanceof Error ? err.message : String(err));
    }
  }

  /** One sync; a sync asked for while one runs follows it. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const token = validToken();
    if (!syncState().on) return this.render();
    if (!token) return this.render('Sign in again to keep syncing.');
    if (!navigator.onLine) return this.render("Offline: syncs when you're back online.");
    this.render('Syncing…');
    try {
      // Nothing changed here and the file is as this device left it: nothing to download or send.
      const start = syncState();
      const localChange = start.changedAt;
      const dirty = localChange !== undefined && localChange !== start.syncedAt;
      const file = await readSyncFile(token, dirty ? null : start.version ?? null);
      if (file.unchanged) {
        setSyncState({ ...syncState(), lastSync: Date.now() });
        return this.render();
      }
      const plan = planSync({ saved: await listSaved(), tracks: await listTracks(), deleted: deletions() }, file.data);
      // Something edited or deleted here while this sync ran wins over what it brings in.
      const nowSaved = new Map((await listSaved()).map((x) => [x.id, x]));
      const nowTracks = new Map((await listTracks()).map((x) => [x.id, x]));
      const goneNow = deletions();
      const newer = <T extends { id: string; added: number; updated?: number }>(mine: T | undefined, theirs: T) =>
        (!!mine && changedAt(mine) > changedAt(theirs)) || (goneNow[theirs.id] ?? -Infinity) >= changedAt(theirs);
      const putSaved_ = plan.putSaved.filter((x) => !newer(nowSaved.get(x.id), x));
      const putTracks_ = plan.putTracks.filter((x) => !newer(nowTracks.get(x.id), x));
      for (const x of putSaved_) await putSaved(x);
      for (const t of putTracks_) await putTrack(t);
      for (const i of plan.removeSaved) await deleteSaved(i);
      for (const i of plan.removeTracks) await deleteTrack(i);
      // Deletions made here meanwhile are kept: merge, don't overwrite.
      const gone = deletions();
      for (const [id, at] of Object.entries(plan.deleted)) gone[id] = Math.max(at, gone[id] ?? 0);
      setDeletions(gone);
      let { id, version } = file;
      if (plan.upload) ({ id, version } = await writeSyncFile(token, id, plan.upload));
      for (const extra of file.extra) await deleteSyncFile(token, extra).catch(() => {});
      // A change here during the sync, or one not sent (kept over what came in): sync again.
      const skipped = putSaved_.length !== plan.putSaved.length || putTracks_.length !== plan.putTracks.length;
      setSyncState({ ...syncState(), lastSync: Date.now(), fileId: id ?? undefined, version: version ?? undefined, syncedAt: skipped ? undefined : localChange });
      if (skipped || syncState().changedAt !== localChange) this.schedule();
      if (putSaved_.length || putTracks_.length || plan.removeSaved.length || plan.removeTracks.length) await this.reload();
      this.render();
    } catch (err) {
      if (err instanceof DriveError && err.status === 401) {
        setSyncState({ ...syncState(), token: undefined, expires: undefined });
        return this.render('Sign in again to keep syncing.');
      }
      // A request that never got an answer (no connection, or one that only looks connected): try
      // again when the connection comes back or the app is opened again.
      if (err instanceof TypeError) return this.render("Offline: syncs when you're back online.");
      this.render(`Couldn't sync: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private render(message?: string): void {
    const s = syncState();
    const signedIn = s.on && !!validToken(s);
    $('sync-connect').hidden = signedIn;
    $('sync-connect').textContent = s.on ? 'Sign in to Google' : 'Sync with Google Drive';
    $('sync-now').hidden = !signedIn;
    $('sync-stop').hidden = !s.on;
    // A short state under the menu item.
    $('sync-menu-status').textContent = !s.on ? '' : message === 'Syncing…' ? 'Syncing…' : !signedIn ? 'Sign-in needed' : message?.startsWith('Offline') ? 'Offline' : message ? 'Not synced' : s.lastSync ? `Synced ${timeText(s.lastSync)}` : '';
    $('sync-text').textContent = message
      ?? (!s.on
        ? 'Keep your saved places and routes and your GPX tracks the same on all your devices, through your Google Drive (in a hidden folder only this app can see).'
        : s.lastSync ? `Synced with Google Drive at ${timeText(s.lastSync)}.` : 'Syncing with Google Drive.');
  }
}
