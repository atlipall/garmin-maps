import { DEV } from '../channel';
import { API, call, UPLOAD } from './drive';

/** Each synced photo's picture is a file of its own in Drive's hidden app folder, named after the
 *  photo's id (the development version keeps its own). Its details are in the sync file. */
const PREFIX = DEV ? 'garmin-map-dev-photo-' : 'garmin-map-photo-';

export const photoFileName = (id: string) => `${PREFIX}${id}.jpg`;

/** The photo pictures in Drive: photo id → file id. */
export async function listPhotoFiles(token: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const q = encodeURIComponent(`name contains '${PREFIX}' and trashed = false`);
  let page: string | undefined;
  do {
    const url = `${API}/files?spaces=appDataFolder&q=${q}&pageSize=1000&fields=nextPageToken,files(id,name)${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
    const res = (await (await call(token, url)).json()) as { nextPageToken?: string; files?: Array<{ id: string; name: string }> };
    for (const f of res.files ?? []) {
      if (typeof f.name === 'string' && f.name.startsWith(PREFIX) && f.name.endsWith('.jpg')) out.set(f.name.slice(PREFIX.length, -4), f.id);
    }
    page = res.nextPageToken;
  } while (page);
  return out;
}

export async function uploadPhotoFile(token: string, id: string, picture: Blob): Promise<string> {
  const boundary = `garmin-map-${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: photoFileName(id), parents: ['appDataFolder'], mimeType: 'image/jpeg' });
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, picture, `\r\n--${boundary}--`]);
  const res = await call(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return ((await res.json()) as { id: string }).id;
}

export async function downloadPhotoFile(token: string, fileId: string): Promise<Blob> {
  const blob = await (await call(token, `${API}/files/${fileId}?alt=media`)).blob();
  return blob.type === 'image/jpeg' ? blob : new Blob([blob], { type: 'image/jpeg' });
}

export async function deletePhotoFile(token: string, fileId: string): Promise<void> {
  await call(token, `${API}/files/${fileId}`, { method: 'DELETE' });
}
