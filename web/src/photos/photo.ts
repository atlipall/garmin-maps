import { run } from '../storage/idb';

/** A photo added to the map: where and when it was taken, what with, and its description. The
 *  picture itself (a copy at most 2048 px, with the original's metadata) and its thumbnail are
 *  kept apart, in `photoFiles`, so the list of photos stays small to read and to sync. */
export interface Photo {
  id: string;
  /** When it was added (ms). */
  added: number;
  /** When it was last changed (ms), for syncing; none: never changed. */
  updated?: number;
  lon: number;
  lat: number;
  /** Metres above sea level, when the photo says. */
  alt: number | null;
  /** When it was taken, by the camera's clock ("2026-08-14T15:42:10"), when the photo says. */
  taken: string | null;
  /** The camera line: "iPhone 13 · 26 mm · f/1.6 · 1/1200 s" (empty when unknown). */
  camera: string;
  /** The copy's size in pixels and bytes. */
  width: number;
  height: number;
  bytes: number;
  /** The original file's name. */
  name: string;
  description?: string;
}

/** The picture and its thumbnail (a square for the map and lists). */
export interface PhotoFiles {
  id: string;
  full: Blob;
  thumb: Blob;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** A photo record that looks right (one that doesn't is left out, here and when syncing). */
export function isPhoto(v: unknown): v is Photo {
  const p = v as Photo;
  return !!p && isStr(p.id) && isNum(p.added) && (p.updated === undefined || isNum(p.updated))
    && isNum(p.lon) && isNum(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
    && (p.alt === null || isNum(p.alt)) && (p.taken === null || (isStr(p.taken) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(p.taken)))
    && isStr(p.camera) && isNum(p.width) && isNum(p.height) && isNum(p.bytes) && isStr(p.name)
    && (p.description === undefined || isStr(p.description));
}

/** Oldest first; photos with no time by when they were added, after the rest. */
export const byTime = (a: Photo, b: Photo) => (a.taken ?? '\uffff').localeCompare(b.taken ?? '\uffff') || a.added - b.added;

export const listPhotos = async (): Promise<Photo[]> =>
  (await run('photos', 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>)).filter(isPhoto).sort(byTime);

export const putPhoto = (p: Photo): Promise<unknown> => run('photos', 'readwrite', (s) => s.put(p));

export const getFiles = async (id: string): Promise<PhotoFiles | null> =>
  ((await run('photoFiles', 'readonly', (s) => s.get(id) as IDBRequest<PhotoFiles | undefined>)) ?? null);

export const putFiles = (f: PhotoFiles): Promise<unknown> => run('photoFiles', 'readwrite', (s) => s.put(f));

/** The ids that have their picture here (a synced photo's picture may still be on its way). */
export const filesHere = async (): Promise<Set<string>> =>
  new Set((await run('photoFiles', 'readonly', (s) => s.getAllKeys())) as string[]);

export async function deletePhoto(id: string): Promise<void> {
  await run('photos', 'readwrite', (s) => s.delete(id));
  await run('photoFiles', 'readwrite', (s) => s.delete(id));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 14 Aug 2026 · 15:42", the time as the camera showed it; `short`: "14 Aug 15:42". */
export function takenText(taken: string | null, short = false): string {
  const m = taken && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(taken);
  if (!m) return 'Time not known';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return short ? `${d} ${MONTHS[mo - 1]} ${m[4]}:${m[5]}` : `${day} ${d} ${MONTHS[mo - 1]} ${y} · ${m[4]}:${m[5]}`;
}

/** The day heading a photo goes under: "Fri 14 Aug 2026" (null: time not known). */
export function dayText(taken: string | null): string | null {
  return taken ? takenText(taken).split(' · ')[0] : null;
}

/** The file name a shared copy gets. */
export function shareName(p: Photo): string {
  const base = p.name.replace(/\.[a-z0-9]+$/i, '') || 'Photo';
  return `${base}.jpg`;
}
