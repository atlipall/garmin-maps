import { storageRoot } from '../channel';
import { currentDirName, hasDataDirs, isDataDir, isMissing, listEntries, parseMeta, POINTER, type StoredMeta } from './layout';

export type { StoredMeta };

export interface Stored {
  meta: StoredMeta;
  img: File;
  hgt: File[];
  overview: File | null;
}

export const cacheKey = (m: StoredMeta) => `${m.imgName}|${m.imgSize}|${m.imgLastModified}`;

/** The current map's directory (see layout.ts), or null when no map is stored. */
async function currentDir(): Promise<FileSystemDirectoryHandle | null> {
  const root = await storageRoot();
  const name = await currentDirName(root);
  return name ? root.getDirectoryHandle(name) : null;
}

export async function loadStored(): Promise<Stored | null> {
  try {
    const d = await currentDir();
    if (!d) return null;
    const meta = parseMeta(await (await (await d.getFileHandle('meta.json')).getFile()).text());
    if (!meta) return null;
    const img = await (await d.getFileHandle('map.img')).getFile();
    if (img.size !== meta.imgSize) return null;
    const demDir = meta.hgtNames.length ? await d.getDirectoryHandle('dem') : null;
    const hgt = demDir ? await Promise.all(meta.hgtNames.map(async (n) => (await demDir.getFileHandle(n)).getFile())) : [];
    const overview = meta.hasOverview ? await (await d.getFileHandle('dem-overview.bin')).getFile() : null;
    return { meta, img, hgt, overview };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function readText(name: string): Promise<string | null> {
  try {
    const d = await currentDir();
    return d ? await (await d.getFileHandle(name)).getFile().then((f) => f.text()) : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function runWorker(msg: Record<string, unknown>, onProgress?: (m: string) => void): Promise<void> {
  const w = new Worker(new URL('./storageWorker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.message);
      else if (m.type === 'done') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'storage worker failed'));
    w.postMessage(msg);
  }).finally(() => w.terminate());
}

export const importFiles = (img: File, hgt: File[], onProgress: (m: string) => void) => runWorker({ type: 'import', img, hgt }, onProgress);

/** Downloads a zipped map and stores it as `imgName`, like an import of that file. */
export const downloadMap = (url: string, imgName: string, onProgress: (m: string) => void) => runWorker({ type: 'download', url, imgName }, onProgress);

/** Writes a small text file into the current map's directory; rejects when no map is stored. */
export async function writeText(name: string, text: string): Promise<void> {
  const dir = await currentDirName(await storageRoot());
  if (!dir) throw new Error('no stored map to write into');
  await runWorker({ type: 'writeText', dir, name, text });
}

/** Removes the stored map: the commit pointer first (so a partial removal reads as "no map"),
 *  then every map directory. Throws if anything could not be removed. */
export async function clearStored(): Promise<void> {
  const root = await storageRoot();
  const errors: string[] = [];
  const remove = async (name: string, recursive: boolean) => {
    try {
      await root.removeEntry(name, { recursive });
    } catch (err) {
      if (!isMissing(err)) errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await remove(POINTER, false);
  for (const e of await listEntries(root)) if (e.kind === 'directory' && isDataDir(e.name)) await remove(e.name, true);
  if (errors.length) throw new Error(`Could not remove the stored map: ${errors.join('; ')}`);
}

/** Whether any map data exists in storage, even if it isn't a loadable map (so the user can
 *  still be offered "Remove stored map"). */
export async function hasStoredData(): Promise<boolean> {
  return hasDataDirs(await storageRoot());
}

export async function requestPersistence(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
