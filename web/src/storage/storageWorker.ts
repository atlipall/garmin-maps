/// <reference lib="webworker" />
import { decodeHgt, HGT_BYTES, parseHgtName } from '../dem/hgt';
import { encodeOverview, OverviewBuilder } from '../dem/overview';
import { ImgError } from '../img/bytes';
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';

declare const self: DedicatedWorkerGlobalScope;

const DIR = 'garmin';
const CHUNK = 8 * 1024 * 1024;

const progress = (message: string) => self.postMessage({ type: 'progress', message });

async function writeBytes(dir: FileSystemDirectoryHandle, name: string, write: (h: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    handle.truncate(0);
    await write(handle);
    handle.flush();
  } finally {
    handle.close();
  }
}

async function doImport(img: File, hgt: File[]): Promise<void> {
  progress('Checking map file…');
  await GarminMap.open(new BlobSource(img)); // throws a tile-named ImgError for locked/corrupt maps
  const parsed = hgt
    .map((f) => {
      const p = parseHgtName(f.name);
      if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
      if (f.size !== HGT_BYTES) throw new ImgError(`${f.name}: not a 1201×1201 SRTM3 tile (${f.size} bytes)`);
      return { file: f, name: f.name.toLowerCase(), ...p };
    })
    // Sorted by name so tiles are added to the overview in the same order as the Python
    // pipeline and the Dem class, which both apply files in name order (shared edges are
    // "last write wins").
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);
  const dir = await root.getDirectoryHandle(DIR, { create: true });

  await writeBytes(dir, 'map.img', async (h) => {
    for (let off = 0; off < img.size; off += CHUNK) {
      h.write(new Uint8Array(await img.slice(off, off + CHUNK).arrayBuffer()), { at: off });
      progress(`Copying map ${Math.min(100, Math.round(((off + CHUNK) / img.size) * 100))}%`);
    }
  });

  if (parsed.length) {
    const demDir = await dir.getDirectoryHandle('dem', { create: true });
    const builder = new OverviewBuilder(parsed);
    for (const [i, p] of parsed.entries()) {
      const bytes = new Uint8Array(await p.file.arrayBuffer());
      await writeBytes(demDir, p.name, async (h) => void h.write(bytes, { at: 0 }));
      builder.add(p.south, p.west, decodeHgt(bytes));
      progress(`Copying elevation ${i + 1}/${parsed.length}`);
    }
    const ov = encodeOverview(builder.finish());
    await writeBytes(dir, 'dem-overview.bin', async (h) => void h.write(ov, { at: 0 }));
  }

  const meta = {
    version: 1, imgName: img.name, imgSize: img.size, imgLastModified: img.lastModified,
    hgtNames: parsed.map((p) => p.name).sort(), hasOverview: parsed.length > 0,
  };
  const text = new TextEncoder().encode(JSON.stringify(meta));
  await writeBytes(dir, 'meta.json', async (h) => void h.write(text, { at: 0 })); // written last: commit marker
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'import') await doImport(msg.img as File, msg.hgt as File[]);
    else if (msg.type === 'writeText') {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
      const bytes = new TextEncoder().encode(msg.text as string);
      await writeBytes(dir, msg.name as string, async (h) => void h.write(bytes, { at: 0 }));
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
