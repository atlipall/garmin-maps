/**
 * Signing in to Google for Drive sync, with Google Identity Services (a script from Google, loaded
 * only when sync is used). Asks for the drive.appdata scope alone: the app's hidden folder, none of
 * the user's own files. An access token lasts about an hour; it is kept in localStorage so sync runs
 * without a new sign-in until then, and a tap on "Sign in" gets a fresh one.
 */

/** The app's OAuth client ID (public; made in Google Cloud Console), or VITE_GOOGLE_CLIENT_ID at
 *  build time (the e2e run uses a fake). Empty: sync isn't offered. */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || '461823178284-761cjr28lki3ocobgt9n8kag1op4f5rp.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS = 'https://accounts.google.com/gsi/client';
const KEY = 'google-sync';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string }): void }
interface Gis { accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient; revoke(token: string, done?: () => void): void } } }

/** What's remembered on this device: whether sync is on, the current token and the last sync. */
export interface SyncState {
  on: boolean;
  token?: string;
  expires?: number;
  lastSync?: number;
  fileId?: string;
  /** The sync file's version after the last sync here (unchanged since: no download needed). */
  version?: string;
  /** When something last changed here, and the last such change a sync has taken in. */
  changedAt?: number;
  syncedAt?: number;
}

export function syncState(): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return s && typeof s === 'object' ? { on: s.on === true, token: s.token, expires: s.expires, lastSync: s.lastSync, fileId: s.fileId, version: s.version, changedAt: s.changedAt, syncedAt: s.syncedAt } : { on: false };
  } catch {
    return { on: false };
  }
}

export function setSyncState(s: SyncState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered: sync asks to sign in again next time
  }
}

/** A token that still has a minute or more left. */
export function validToken(s: SyncState = syncState()): string | null {
  return s.token && s.expires && s.expires - Date.now() > 60_000 ? s.token : null;
}

let gis: Promise<Gis> | null = null;
let client: TokenClient | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

/** Loads the Google script and prepares sign-in, so a later tap can open it at once (browsers only
 *  allow the sign-in window straight from a tap). */
export function prepareSignIn(): Promise<void> {
  gis ??= new Promise<Gis>((resolve, reject) => {
    const w = window as unknown as { google?: Gis };
    if (w.google?.accounts?.oauth2) return resolve(w.google);
    const script = document.createElement('script');
    script.src = GIS;
    script.async = true;
    script.onload = () => (w.google ? resolve(w.google) : reject(new Error('Google sign-in did not load.')));
    script.onerror = () => {
      gis = null;
      reject(new Error('Google sign-in could not be loaded (offline?).'));
    };
    document.head.append(script);
  });
  return gis.then((g) => {
    client ??= g.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (!r.access_token) return p.reject(new Error(r.error === 'access_denied' ? 'Google Drive access was not allowed.' : 'Google sign-in failed.'));
        setSyncState({ ...syncState(), on: true, token: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 });
        p.resolve(r.access_token);
      },
      error_callback: (e) => {
        const p = pending;
        pending = null;
        p?.reject(new Error(e.type === 'popup_closed' ? 'Sign-in was closed.' : 'Google sign-in failed.'));
      },
    });
  });
}

/** Opens Google sign-in (call from a tap, after prepareSignIn). */
export function signIn(): Promise<string> {
  if (!client) return Promise.reject(new Error('Google sign-in is still loading; try again in a moment.'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client!.requestAccessToken({ prompt: syncState().on ? '' : 'consent' });
  });
}

/** Stops syncing on this device (the file in Drive stays, for other devices). */
export function signOut(): void {
  const s = syncState();
  const g = (window as unknown as { google?: Gis }).google;
  if (s.token && g) g.accounts.oauth2.revoke(s.token);
  setSyncState({ on: false });
}
