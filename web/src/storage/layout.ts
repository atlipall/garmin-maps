/** OPFS layout shared by the page (store.ts) and the storage worker.
 *
 *  Each import writes a fresh versioned directory `garmin-<timestamp>/` (map.img, dem/*.hgt,
 *  dem-overview.bin, meta.json, later places.json). The root pointer file `current.json`
 *  (`{"dir": "garmin-<ts>"}`) is written LAST and is the commit: until it names the new directory,
 *  the previously stored map stays the current one. Maps stored before this layout live in the
 *  legacy `garmin/` directory.
 *
 *  The pointer is only a hint. OPFS has no atomic rename, so an interrupted pointer write can leave
 *  it empty, torn or naming a directory that is gone; `resolveCurrentDir` then falls back to the
 *  newest complete map directory, so a stored map is never "lost" (and never cleaned up) just
 *  because the pointer is bad. */
export const LEGACY_DIR = 'garmin';
export const POINTER = 'current.json';
export const DIR_PREFIX = 'garmin-';

const DIR_RE = /^garmin-(\d+)(?:-(\d+))?$/;

export interface StoredMeta {
  version: 1;
  imgName: string;
  imgSize: number;
  imgLastModified: number;
  hgtNames: string[];
  hasOverview: boolean;
}

export const isDataDir = (name: string) => name === LEGACY_DIR || name.startsWith(DIR_PREFIX);

export const isMissing = (err: unknown) =>
  err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

/** The directory named by the pointer's text, or null for an empty/torn/unparseable pointer. */
export function parsePointer(text: string | null): string | null {
  if (!text) return null;
  try {
    const dir = (JSON.parse(text) as { dir?: unknown } | null)?.dir;
    return typeof dir === 'string' && DIR_RE.test(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** null for missing/corrupt/unknown-version meta. */
export function parseMeta(text: string | null): StoredMeta | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<StoredMeta> | null;
    if (!m || m.version !== 1 || typeof m.imgSize !== 'number' || !Array.isArray(m.hgtNames)) return null;
    return m as StoredMeta;
  } catch {
    return null;
  }
}

/** What `resolveCurrentDir` needs to know about storage; OPFS in the app, a fake in tests. */
export interface LayoutAdapter {
  /** Raw text of the pointer file, or null when it doesn't exist. */
  pointerText(): Promise<string | null>;
  /** Names of the root's subdirectories. */
  dirs(): Promise<string[]>;
  /** A directory is a complete map when its meta.json parses and map.img has meta's size. */
  isComplete(dir: string): Promise<boolean>;
}

/** Newest first: by timestamp, then collision suffix. */
function byNewest(a: string, b: string): number {
  const ma = DIR_RE.exec(a)!;
  const mb = DIR_RE.exec(b)!;
  return Number(mb[1]) - Number(ma[1]) || Number(mb[2] ?? 0) - Number(ma[2] ?? 0);
}

/** Name of the directory holding the current map, or null when no complete map is stored:
 *  1. the pointer's directory, if it exists and is complete;
 *  2. else the newest complete `garmin-<ts>` directory;
 *  3. else the legacy `garmin/` directory, if complete. */
export async function resolveCurrentDir(io: LayoutAdapter): Promise<string | null> {
  const dirs = new Set(await io.dirs());
  const pointed = parsePointer(await io.pointerText());
  if (pointed && dirs.has(pointed) && (await io.isComplete(pointed))) return pointed;
  const versioned = [...dirs].filter((d) => DIR_RE.test(d) && d !== pointed).sort(byNewest);
  for (const d of versioned) if (await io.isComplete(d)) return d;
  if (dirs.has(LEGACY_DIR) && (await io.isComplete(LEGACY_DIR))) return LEGACY_DIR;
  return null;
}

/** Names and kinds of a directory's entries (OPFS directory handles are async-iterable). */
export async function listEntries(dir: FileSystemDirectoryHandle): Promise<Array<{ name: string; kind: FileSystemHandleKind }>> {
  const out: Array<{ name: string; kind: FileSystemHandleKind }> = [];
  const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, handle] of iterable.entries()) out.push({ name, kind: handle.kind });
  return out;
}

async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Complete-map check against OPFS; any missing piece means incomplete. */
export async function isCompleteDir(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const dir = await root.getDirectoryHandle(name);
    const meta = parseMeta(await readTextFile(dir, 'meta.json'));
    if (!meta) return false;
    return (await (await dir.getFileHandle('map.img')).getFile()).size === meta.imgSize;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export function opfsAdapter(root: FileSystemDirectoryHandle): LayoutAdapter {
  return {
    pointerText: () => readTextFile(root, POINTER),
    dirs: async () => (await listEntries(root)).filter((e) => e.kind === 'directory').map((e) => e.name),
    isComplete: (name) => isCompleteDir(root, name),
  };
}

export const currentDirName = (root: FileSystemDirectoryHandle) => resolveCurrentDir(opfsAdapter(root));

/** Whether any map data directory exists at all (complete or not). */
export async function hasDataDirs(root: FileSystemDirectoryHandle): Promise<boolean> {
  return (await listEntries(root)).some((e) => e.kind === 'directory' && isDataDir(e.name));
}
