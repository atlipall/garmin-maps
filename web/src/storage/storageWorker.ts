/// <reference lib="webworker" />
import { decodeHgt, HGT_BYTES, parseHgtName } from '../dem/hgt';
import { encodeOverview, OverviewBuilder } from '../dem/overview';
import { ImgError } from '../img/bytes';
import { BlobSource } from '../img/source';
import { storageRoot } from '../channel';
import { GarminMap } from '../map/garminMap';
import { currentDirName, DIR_PREFIX, isCompleteDir, isDataDir, isMissing, listEntries, opfsAdapter, parsePointer, POINTER } from './layout';

declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 8 * 1024 * 1024;
/** Free space required before copying, as a multiple of the bytes to be written. */
const SPACE_MARGIN = 1.1;

const progress = (message: string) => self.postMessage({ type: 'progress', message });
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

// The sync access handle's methods return promises on older Safari (pre-17) and plain values on
// newer engines; awaiting is harmless on the latter and required on the former.
async function writeBytes(dir: FileSystemDirectoryHandle, name: string, write: (h: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.truncate(0);
    await write(handle);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

/** Overwrites a small file with one write and then trims it, so it is never observed empty (the
 *  commit pointer must not be left blank by an interruption between truncate and write). */
async function writeSmall(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.write(bytes, { at: 0 });
    await handle.truncate(bytes.length);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

async function checkSpace(needed: number): Promise<void> {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (!est || est.quota == null || est.usage == null) return; // unknown: let the copy try
  const free = est.quota - est.usage;
  if (free < needed * SPACE_MARGIN) {
    throw new ImgError(
      `Not enough storage space on this device: the import needs about ${mb(needed * SPACE_MARGIN)} but only ${mb(Math.max(0, free))} is available. ` +
        'Nothing was changed. If a map is already stored, you can remove it with “Remove stored map” and then import again.',
    );
  }
}

async function removeDir(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  await root.removeEntry(name, { recursive: true }).catch((err) => {
    if (!isMissing(err)) console.warn('could not remove', name, err);
  });
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
  // Built before copying anything so an oversized elevation extent fails up front.
  const builder = parsed.length ? new OverviewBuilder(parsed) : null;

  await checkSpace(img.size + parsed.reduce((n, p) => n + p.file.size, 0));

  const root = await storageRoot();
  let name = `${DIR_PREFIX}${Date.now()}`;
  const existing = new Set((await listEntries(root)).map((e) => e.name));
  for (let i = 1; existing.has(name); i++) name = `${DIR_PREFIX}${Date.now()}-${i}`;

  // Everything goes into a fresh directory; the stored map is untouched until the pointer flips.
  const dir = await root.getDirectoryHandle(name, { create: true });
  try {
    await writeBytes(dir, 'map.img', async (h) => {
      for (let off = 0; off < img.size; off += CHUNK) {
        await h.write(new Uint8Array(await img.slice(off, off + CHUNK).arrayBuffer()), { at: off });
        progress(`Copying map ${Math.min(100, Math.round(((off + CHUNK) / img.size) * 100))}%`);
      }
    });

    if (builder) {
      const demDir = await dir.getDirectoryHandle('dem', { create: true });
      for (const [i, p] of parsed.entries()) {
        const bytes = new Uint8Array(await p.file.arrayBuffer());
        await writeBytes(demDir, p.name, async (h) => void (await h.write(bytes, { at: 0 })));
        builder.add(p.south, p.west, decodeHgt(bytes));
        progress(`Copying elevation ${i + 1}/${parsed.length}`);
      }
      const ov = encodeOverview(builder.finish());
      await writeBytes(dir, 'dem-overview.bin', async (h) => void (await h.write(ov, { at: 0 })));
    }

    const meta = {
      version: 1, imgName: img.name, imgSize: img.size, imgLastModified: img.lastModified,
      hgtNames: parsed.map((p) => p.name).sort(), hasOverview: parsed.length > 0,
    };
    const text = new TextEncoder().encode(JSON.stringify(meta));
    await writeBytes(dir, 'meta.json', async (h) => void (await h.write(text, { at: 0 })));

    // The commit: from here on the new directory is the stored map.
    await writeSmall(root, POINTER, new TextEncoder().encode(JSON.stringify({ dir: name })));
  } catch (err) {
    progress('Import failed; keeping the stored map.');
    if (await safeToDiscard(root, name)) await removeDir(root, name);
    throw err;
  }

  // Best effort: drop every other map directory (older imports, the legacy `garmin/`, partial
  // leftovers of an interrupted import), but only once storage demonstrably resolves to the new
  // map. A failure here only wastes space until the next import.
  progress('Cleaning up…');
  if ((await currentDirName(root).catch(() => null)) !== name) return;
  for (const e of await listEntries(root).catch(() => [])) {
    if (e.kind === 'directory' && e.name !== name && isDataDir(e.name)) await removeDir(root, e.name);
  }
}

/** A failed import's directory may be removed only if it isn't (possibly) the stored map: not
 *  named by the pointer (its bytes may have landed before the error) and not the only complete
 *  map directory there is. Any doubt keeps it. */
async function safeToDiscard(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const io = opfsAdapter(root);
    if (parsePointer(await io.pointerText()) === name) return false;
    if (!(await isCompleteDir(root, name))) return true;
    for (const d of await io.dirs()) if (d !== name && isDataDir(d) && (await isCompleteDir(root, d))) return true;
    return false;
  } catch {
    return false;
  }
}

async function doWriteText(dirName: string, name: string, text: string): Promise<void> {
  // No `create`: if the map directory vanished meanwhile, fail rather than resurrect it.
  const dir = await (await storageRoot()).getDirectoryHandle(dirName);
  await writeBytes(dir, name, async (h) => void (await h.write(new TextEncoder().encode(text), { at: 0 })));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'import') await doImport(msg.img as File, msg.hgt as File[]);
    else if (msg.type === 'writeText') await doWriteText(msg.dir as string, msg.name as string, msg.text as string);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
