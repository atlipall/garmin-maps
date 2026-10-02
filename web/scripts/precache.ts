import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Build } from '../src/buildInfo.ts';

/** Build-time step that stamps `dist/sw.js` (see `public/sw.js` and the Vite plugin in
 *  vite.config.ts): the service worker's precache list becomes every file of the build, its cache
 *  name a hash of those files, so each deploy installs a fresh, complete offline copy, and its build
 *  stamp the one the page carries, so a page can tell a newer version is installed. */

export interface BuiltFile {
  /** Path relative to the output directory, with `/` separators. */
  path: string;
  /** Content hash (any stable string). */
  hash: string;
}

const CACHE_RE = /self\.__CACHE__\s*\|\|\s*'[^']*'/g;
const PRECACHE_RE = /self\.__PRECACHE__\s*\|\|\s*\[[^\]]*\]/g;
const BUILD_RE = /self\.__BUILD__\s*\|\|\s*null/g;


/** Files that must not be precached: the service worker itself and source maps. */
export const isPrecached = (path: string) => path !== 'sw.js' && !path.endsWith('.map');

/** `./`-relative URL for a built file, each segment percent-encoded (e.g. font names with spaces). */
export const toUrl = (path: string) => './' + path.split('/').map(encodeURIComponent).join('/');

export function cacheName(files: BuiltFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.hash}\n`);
  return `garmin-app-${h.digest('hex').slice(0, 12)}`;
}

/** Pure: replaces the `self.__CACHE__ || '…'`, `self.__PRECACHE__ || […]` and `self.__BUILD__ ||
 *  null` placeholders in the service worker template with the build's cache name, file URLs (`./`
 *  first, then the files sorted) and stamp. Throws if a placeholder does not occur exactly once. */
export function injectPrecache(template: string, files: BuiltFile[], build: Build): string {
  for (const [re, name] of [[CACHE_RE, '__CACHE__'], [PRECACHE_RE, '__PRECACHE__'], [BUILD_RE, '__BUILD__']] as const) {
    const n = template.match(re)?.length ?? 0;
    if (n !== 1) throw new Error(`sw.js: expected one self.${name} placeholder, found ${n}`);
  }
  const kept = files.filter((f) => isPrecached(f.path));
  const urls = ['./', ...kept.map((f) => toUrl(f.path)).sort()];
  return template
    .replace(CACHE_RE, () => JSON.stringify(cacheName(kept)))
    .replace(PRECACHE_RE, () => JSON.stringify(urls))
    .replace(BUILD_RE, () => JSON.stringify(build));
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
export async function stampServiceWorker(outDir: string, build: Build): Promise<{ cache: string; count: number }> {
  const files: BuiltFile[] = [];
  for (const abs of await walk(outDir)) {
    const path = relative(outDir, abs).split(sep).join('/');
    if (!isPrecached(path)) continue;
    files.push({ path, hash: createHash('sha256').update(await readFile(abs)).digest('hex') });
  }
  const swPath = join(outDir, 'sw.js');
  await writeFile(swPath, injectPrecache(await readFile(swPath, 'utf8'), files, build));
  return { cache: cacheName(files), count: files.length };
}
