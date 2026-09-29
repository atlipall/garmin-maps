import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const SITE = new URL('../site/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, SITE), 'utf8');

describe('site root', () => {
  test('the instructions page links to the app and registers no service worker', () => {
    const html = read('index.html');
    expect(html).toMatch(/href="app\/"/);
    expect(html).not.toMatch(/serviceWorker/);
  });

  test('the root sw.js retires the old root app: deletes its garmin-map-* caches, unregisters, reloads its pages', async () => {
    const deleted: string[] = [];
    const navigated: string[] = [];
    let unregistered = false;
    const handlers: Record<string, (e: { waitUntil(p: Promise<unknown>): void }) => void> = {};
    const self = {
      addEventListener: (type: string, fn: never) => { handlers[type] = fn; },
      skipWaiting: async () => {},
      registration: { unregister: async () => { unregistered = true; return true; } },
      clients: { matchAll: async () => [{ url: 'https://x/garmin-maps/', navigate: async (u: string) => { navigated.push(u); } }] },
    };
    const caches = {
      keys: async () => ['garmin-map-0123456789ab', 'garmin-map-dev', 'garmin-app-0123456789ab', 'other-project-v1'],
      delete: async (k: string) => { deleted.push(k); return true; },
    };
    new Function('self', 'caches', read('sw.js'))(self, caches);
    let done: Promise<unknown> = Promise.resolve();
    handlers.install?.({ waitUntil: (p) => { done = p; } });
    await done;
    handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    expect(deleted).toEqual(['garmin-map-0123456789ab', 'garmin-map-dev']);
    expect(unregistered).toBe(true);
    expect(navigated).toEqual(['https://x/garmin-maps/']);
  });
});
