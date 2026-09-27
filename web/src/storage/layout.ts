/** OPFS layout shared by the page (store.ts) and the storage worker.
 *
 *  Each import writes a fresh versioned directory `garmin-<timestamp>/` (map.img, dem/*.hgt,
 *  dem-overview.bin, meta.json, later places.json). The root pointer file `current.json`
 *  (`{"dir": "garmin-<ts>"}`) is written LAST and is the commit: until it names the new directory,
 *  the previously stored map stays the current one. Maps stored before this layout live in the
 *  legacy `garmin/` directory, which is still loaded when there is no pointer. */
export const LEGACY_DIR = 'garmin';
export const POINTER = 'current.json';
export const DIR_PREFIX = 'garmin-';

const DIR_RE = /^garmin-[0-9A-Za-z_-]+$/;

export const isDataDir = (name: string) => name === LEGACY_DIR || name.startsWith(DIR_PREFIX);

export const isMissing = (err: unknown) =>
  err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

/** `'missing'` when there is no pointer file, `null` when it exists but is unreadable/corrupt. */
export async function readPointer(root: FileSystemDirectoryHandle): Promise<string | null | 'missing'> {
  let text: string;
  try {
    text = await (await (await root.getFileHandle(POINTER)).getFile()).text();
  } catch (err) {
    if (isMissing(err)) return 'missing';
    throw err;
  }
  try {
    const dir = (JSON.parse(text) as { dir?: unknown } | null)?.dir;
    return typeof dir === 'string' && DIR_RE.test(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Name of the directory holding the current map, or null when there is none: a missing pointer
 *  falls back to the legacy directory; a corrupt pointer, or one naming a missing directory, is
 *  "no map". */
export async function currentDirName(root: FileSystemDirectoryHandle): Promise<string | null> {
  const p = await readPointer(root);
  const name = p === 'missing' ? LEGACY_DIR : p;
  if (!name) return null;
  try {
    await root.getDirectoryHandle(name);
    return name;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Names of the root's entries (OPFS directory handles are async-iterable). */
export async function listEntries(dir: FileSystemDirectoryHandle): Promise<Array<{ name: string; kind: FileSystemHandleKind }>> {
  const out: Array<{ name: string; kind: FileSystemHandleKind }> = [];
  const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, handle] of iterable.entries()) out.push({ name, kind: handle.kind });
  return out;
}
