import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Build-time step that stamps `dist/sw.js` (see `public/sw.js` and the Vite plugin in
 *  vite.config.ts): the service worker's precache list becomes every file of the build, and its
 *  cache name a hash of those files, so each deploy installs a fresh, complete offline copy. */

export interface BuiltFile {
  /** Path relative to the output directory, with `/` separators. */
  path: string;
  /** Content hash (any stable string). */
  hash: string;
}

const CACHE_RE = /self\.__CACHE__\s*\|\|\s*'[^']*'/g;
const PRECACHE_RE = /self\.__PRECACHE__\s*\|\|\s*\[[^\]]*\]/g;

/** Files that must not be precached: the service worker itself and source maps. */
export const isPrecached = (path: string) => path !== 'sw.js' && !path.endsWith('.map');

/** `./`-relative URL for a built file, each segment percent-encoded (e.g. font names with spaces). */
export const toUrl = (path: string) => './' + path.split('/').map(encodeURIComponent).join('/');

export function cacheName(files: BuiltFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.hash}\n`);
  return `garmin-map-${h.digest('hex').slice(0, 12)}`;
}

/** Pure: replaces the `self.__CACHE__ || '…'` and `self.__PRECACHE__ || […]` placeholders in the
 *  service worker template with the build's cache name and file URLs (`./` first, then the files
 *  sorted). Throws if either placeholder does not occur exactly once. */
export function injectPrecache(template: string, files: BuiltFile[]): string {
  const cache = template.match(CACHE_RE) ?? [];
  const pre = template.match(PRECACHE_RE) ?? [];
  if (cache.length !== 1) throw new Error(`sw.js: expected one self.__CACHE__ placeholder, found ${cache.length}`);
  if (pre.length !== 1) throw new Error(`sw.js: expected one self.__PRECACHE__ placeholder, found ${pre.length}`);
  const kept = files.filter((f) => isPrecached(f.path));
  const urls = ['./', ...kept.map((f) => toUrl(f.path)).sort()];
  return template
    .replace(CACHE_RE, () => JSON.stringify(cacheName(kept)))
    .replace(PRECACHE_RE, () => JSON.stringify(urls));
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Lists and hashes every file under `outDir`, then rewrites `outDir/sw.js` in place. */
export async function stampServiceWorker(outDir: string): Promise<{ cache: string; count: number }> {
  const files: BuiltFile[] = [];
  for (const abs of await walk(outDir)) {
    const path = relative(outDir, abs).split(sep).join('/');
    if (!isPrecached(path)) continue;
    files.push({ path, hash: createHash('sha256').update(await readFile(abs)).digest('hex') });
  }
  const swPath = join(outDir, 'sw.js');
  await writeFile(swPath, injectPrecache(await readFile(swPath, 'utf8'), files));
  return { cache: cacheName(files), count: files.length };
}
