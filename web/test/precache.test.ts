import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { cacheName, injectPrecache, toUrl } from '../scripts/precache';

const TEMPLATE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const FILES = [
  { path: 'index.html', hash: 'a1' },
  { path: 'assets/index-abc.js', hash: 'b2' },
  { path: 'assets/index-abc.js.map', hash: 'c3' },
  { path: 'assets/maplibre-gl-worker.mjs', hash: 'd4' },
  { path: 'fonts/Noto Sans Regular/0-255.pbf', hash: 'e5' },
  { path: 'sw.js', hash: 'f6' },
];

/** Evaluates the service worker's top-level constants with a stubbed `self`. */
function constants(src: string): { CACHE: string; PRECACHE: string[] } {
  const body = src.slice(0, src.indexOf("self.addEventListener('install'"));
  return new Function('self', `${body}; return { CACHE, PRECACHE };`)({ location: { origin: 'x' } });
}

describe('injectPrecache', () => {
  test('stamps the cache name and lists every built file except sw.js and source maps', () => {
    const out = injectPrecache(TEMPLATE, FILES);
    const kept = FILES.filter((f) => f.path !== 'sw.js' && !f.path.endsWith('.map'));
    const { CACHE, PRECACHE } = constants(out);
    expect(CACHE).toBe(cacheName(kept));
    expect(CACHE).toMatch(/^garmin-map-[0-9a-f]{12}$/);
    expect(PRECACHE.slice(0, 5)).toEqual([
      './',
      './assets/index-abc.js',
      './assets/maplibre-gl-worker.mjs',
      './fonts/Noto%20Sans%20Regular/0-255.pbf',
      './index.html',
    ]);
    // the template's font list is merged in (deduplicated) after the build's files
    expect(PRECACHE).toContain('./fonts/Noto%20Sans%20Italic/0-255.pbf');
    expect(new Set(PRECACHE).size).toBe(PRECACHE.length);
    expect(PRECACHE.some((u) => u.endsWith('.map') || u.endsWith('sw.js'))).toBe(false);
    expect(out).not.toMatch(/__CACHE__|__PRECACHE__/);
  });

  test('the cache name changes with any file content and ignores list order', () => {
    const base = cacheName(FILES);
    expect(cacheName([...FILES].reverse())).toBe(base);
    expect(cacheName(FILES.map((f) => (f.path === 'index.html' ? { ...f, hash: 'zz' } : f)))).not.toBe(base);
  });

  test('the unstamped template has safe dev defaults', () => {
    const { CACHE, PRECACHE } = constants(TEMPLATE);
    expect(CACHE).toBe('garmin-map-dev');
    expect(PRECACHE[0]).toBe('./');
    expect(PRECACHE).toContain('./manifest.webmanifest');
  });

  test('refuses a template without exactly one of each placeholder', () => {
    expect(() => injectPrecache('const CACHE = "x";', FILES)).toThrow(/__CACHE__/);
    expect(() => injectPrecache(TEMPLATE + TEMPLATE, FILES)).toThrow(/found 2/);
  });

  test('toUrl encodes each path segment', () => {
    expect(toUrl('fonts/Noto Sans Italic/256-511.pbf')).toBe('./fonts/Noto%20Sans%20Italic/256-511.pbf');
  });
});
