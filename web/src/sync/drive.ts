import { parseBackup, type Backup } from '../saved/backup';

/** The one file the app keeps in the user's Google Drive, in the hidden app-data folder (only this
 *  app can see it; the user's own files stay out of reach: scope drive.appdata). */
export const SYNC_FILE = 'garmin-map-sync.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** A Drive request that failed; `status` 401 means the sign-in has expired. */
export class DriveError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DriveError(res.status, res.status === 401 ? 'The Google sign-in has expired.' : `Google Drive answered ${res.status}.`);
  return res;
}

/** The sync file's id and contents, or nulls when there's none yet. */
export async function readSyncFile(token: string): Promise<{ id: string | null; data: Backup | null }> {
  const q = encodeURIComponent(`name='${SYNC_FILE}'`);
  const list = (await (await call(token, `${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`)).json()) as { files?: Array<{ id: string }> };
  const id = list.files?.[0]?.id ?? null;
  if (!id) return { id: null, data: null };
  const text = await (await call(token, `${API}/files/${id}?alt=media`)).text();
  return { id, data: parseBackup(text) };
}

/** Writes the sync file (creating it in the app-data folder the first time); returns its id. */
export async function writeSyncFile(token: string, id: string | null, data: Backup): Promise<string> {
  const body = JSON.stringify(data);
  if (id) {
    await call(token, `${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return id;
  }
  const boundary = `garmin-map-${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await call(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return ((await res.json()) as { id: string }).id;
}
