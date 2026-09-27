const DIR = 'garmin';

export interface StoredMeta {
  version: 1;
  imgName: string;
  imgSize: number;
  imgLastModified: number;
  hgtNames: string[];
  hasOverview: boolean;
}

export interface Stored {
  meta: StoredMeta;
  img: File;
  hgt: File[];
  overview: File | null;
}

export const cacheKey = (m: StoredMeta) => `${m.imgName}|${m.imgSize}|${m.imgLastModified}`;

async function dir(create = false): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create });
}

const isMissing = (err: unknown) => err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

export async function loadStored(): Promise<Stored | null> {
  try {
    const d = await dir();
    const meta = JSON.parse(await (await (await d.getFileHandle('meta.json')).getFile()).text()) as StoredMeta;
    const img = await (await d.getFileHandle('map.img')).getFile();
    if (meta.version !== 1 || img.size !== meta.imgSize) return null;
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
    return await (await (await dir()).getFileHandle(name)).getFile().then((f) => f.text());
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
export const writeText = (name: string, text: string) => runWorker({ type: 'writeText', name, text });

export async function clearStored(): Promise<void> {
  await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }).catch(() => undefined);
}

export async function requestPersistence(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
