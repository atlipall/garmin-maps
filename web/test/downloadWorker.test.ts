import { afterEach, describe, expect, test, vi } from 'vitest';
import { handle, SOURCE, type Env } from '../download-worker/worker';

const env: Env = { ALLOWED_ORIGINS: 'https://atlipall.github.io, http://localhost:5173' };
const APP = 'https://atlipall.github.io';
const call = (path: string, init: { method?: string; origin?: string; range?: string } = {}) =>
  handle(new Request(`https://garmin-maps-download.example.workers.dev${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.origin !== '' ? { Origin: init.origin ?? APP } : {}), ...(init.range ? { Range: init.range } : {}) },
  }), env);

/** A fake source server: records what was asked, answers with a few bytes. */
function source(status = 200) {
  const asked: Array<{ url: string; method: string; range: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    asked.push({ url, method: init.method ?? 'GET', range: new Headers(init.headers).get('Range') });
    return new Response(init.method === 'HEAD' ? null : new Uint8Array([0x50, 0x4b, 3, 4]), {
      status, headers: { 'Content-Length': '4', 'Content-Type': 'application/zip', 'Last-Modified': 'Sun, 13 Sep 2026 16:32:30 GMT', 'Set-Cookie': 'x=1' },
    });
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('the download pass-through', () => {
  test('passes the map through to the app, with the headers it needs', async () => {
    const asked = source();
    const r = await call('/iceland.zip');
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('Content-Length');
    expect(r.headers.get('Last-Modified')).toBe('Sun, 13 Sep 2026 16:32:30 GMT');
    expect(r.headers.get('Set-Cookie')).toBeNull(); // only the listed headers are passed on
    expect(asked).toEqual([{ url: SOURCE, method: 'GET', range: null }]);
  });

  test('passes a Range request and HEAD on', async () => {
    const asked = source(206);
    expect((await call('/iceland.zip', { range: 'bytes=100-' })).status).toBe(206);
    const head = await call('/iceland.zip', { method: 'HEAD' });
    expect(head.headers.get('Content-Length')).toBe('4');
    expect(asked.map((a) => [a.method, a.range])).toEqual([['GET', 'bytes=100-'], ['HEAD', null]]);
  });

  test('answers the preflight; refuses other pages, other paths and other methods without fetching', async () => {
    const asked = source();
    const pre = await call('/iceland.zip', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Range');
    expect((await call('/iceland.zip', { origin: 'https://example.com' })).status).toBe(403);
    expect((await call('/iceland.zip', { origin: '' })).status).toBe(403);
    expect((await call('/https://example.com/other.zip')).status).toBe(404);
    expect((await call('/iceland.zip', { method: 'POST' })).status).toBe(405);
    expect(asked).toEqual([]);
  });

  test('says so when the source is unreachable', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('network'); });
    expect((await call('/iceland.zip')).status).toBe(502);
  });
});
