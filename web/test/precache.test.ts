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
const BUILD = { version: 'abc1234', builtAt: '2026-10-01T12:00:00.000Z' };

/** Evaluates the service worker's top-level constants with a stubbed `self`. */
function constants(src: string): { CACHE: string; PRECACHE: string[]; BUILD: unknown } {
  const body = src.slice(0, src.indexOf("self.addEventListener('install'"));
  return new Function('self', `${body}; return { CACHE, PRECACHE, BUILD };`)({ location: { origin: 'x', pathname: '/garmin-maps/app/sw.js' } });
}

describe('injectPrecache', () => {
  test('stamps the cache name and build, and lists every built file except sw.js and source maps', () => {
    const out = injectPrecache(TEMPLATE, FILES, BUILD);
    const kept = FILES.filter((f) => f.path !== 'sw.js' && !f.path.endsWith('.map'));
    const { CACHE, PRECACHE } = constants(out);
    expect(CACHE).toBe(cacheName(kept));
    expect(CACHE).toMatch(/^garmin-app-[0-9a-f]{12}$/);
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
    expect(constants(out).BUILD).toEqual(BUILD);
    expect(out).not.toMatch(/__CACHE__|__PRECACHE__|__BUILD__/);
  });

  test('the cache name changes with any file content and ignores list order', () => {
    const base = cacheName(FILES);
    expect(cacheName([...FILES].reverse())).toBe(base);
    expect(cacheName(FILES.map((f) => (f.path === 'index.html' ? { ...f, hash: 'zz' } : f)))).not.toBe(base);
  });

  test('the unstamped template has safe dev defaults', () => {
    const { CACHE, PRECACHE, BUILD: build } = constants(TEMPLATE);
    expect(CACHE).toBe('garmin-app-dev');
    expect(build).toBeNull();
    expect(PRECACHE[0]).toBe('./');
    expect(PRECACHE).toContain('./manifest.webmanifest');
  });

  test('refuses a template without exactly one of each placeholder', () => {
    expect(() => injectPrecache('const CACHE = "x";', FILES, BUILD)).toThrow(/__CACHE__/);
    expect(() => injectPrecache(TEMPLATE + TEMPLATE, FILES, BUILD)).toThrow(/found 2/);
  });

  test('toUrl encodes each path segment', () => {
    expect(toUrl('fonts/Noto Sans Italic/256-511.pbf')).toBe('./fonts/Noto%20Sans%20Italic/256-511.pbf');
  });
});

describe('activate', () => {
  /** Runs the worker's activation at `path` over a fake cache storage holding `keys`; returns what
   *  it deleted and the order it remembered. */
  async function activate(path: string, keys: string[], order: string[]) {
    const deleted: string[] = [];
    let onActivate: ((e: { waitUntil(p: Promise<unknown>): void }) => void) | undefined;
    const self = {
      location: { origin: 'x', pathname: path },
      addEventListener: (type: string, fn: never) => { if (type === 'activate') onActivate = fn; },
      clients: { claim: async () => {} },
    };
    const stored = new Map<string, Map<string, string>>();
    const caches = {
      keys: async () => keys,
      delete: async (k: string) => { deleted.push(k); return true; },
      open: async (name: string) => {
        const c = stored.get(name) ?? stored.set(name, new Map()).get(name)!;
        return {
          match: async (k: string) => (c.has(k) ? new Response(c.get(k)) : undefined),
          put: async (k: string, r: Response) => { c.set(k, await r.text()); },
        };
      },
    };
    stored.set(path.includes('/app-dev/') ? 'garmin-appdev-order-v1' : 'garmin-app-order-v1', new Map([['order', JSON.stringify(order)]]));
    new Function('self', 'caches', TEMPLATE)(self, caches);
    let done: Promise<unknown> = Promise.resolve();
    onActivate!({ waitUntil: (p) => { done = p; } });
    await done;
    const orderCache = [...stored].find(([n]) => n.endsWith('order-v1'))!;
    return { deleted, order: JSON.parse(orderCache[1].get('order')!), orderName: orderCache[0] };
  }

  const ALL = ['garmin-app-dev', 'garmin-app-prev', 'garmin-app-older', 'garmin-app-order-v1', 'garmin-appdev-dev', 'garmin-appdev-prev', 'garmin-appdev-older', 'garmin-appdev-order-v1', 'garmin-map-0123456789ab', 'other-project-v1'];

  test("keeps this version's cache and the one before; deletes older ones of this app only", async () => {
    const r = await activate('/garmin-maps/app/sw.js', ALL, ['garmin-app-older', 'garmin-app-prev']);
    // 'garmin-app-dev' is this (unbuilt) version's cache; the development version's are left alone.
    expect(r.deleted).toEqual(['garmin-app-older']);
    expect(r.order).toEqual(['garmin-app-prev', 'garmin-app-dev']);
  });

  test('the development version (/app-dev/) has caches of its own and leaves the app\'s alone', async () => {
    const r = await activate('/garmin-maps/app-dev/sw.js', ALL, ['garmin-appdev-older', 'garmin-appdev-prev']);
    expect(r.deleted).toEqual(['garmin-appdev-older']);
    expect(r.orderName).toBe('garmin-appdev-order-v1');
    expect(r.order).toEqual(['garmin-appdev-prev', 'garmin-appdev-dev']);
  });
});
