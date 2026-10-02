import { afterEach, describe, expect, test, vi } from 'vitest';
import { handle, seal, unseal, type Env } from '../auth-worker/worker';

const env: Env = {
  GOOGLE_CLIENT_ID: 'client',
  GOOGLE_CLIENT_SECRET: 'secret',
  SEAL_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
  ALLOWED_ORIGINS: 'https://atlipall.github.io, http://localhost:5173',
};
const APP = 'https://atlipall.github.io';

/** A fake Google token endpoint: answers with `reply`, records the form posted. */
function google(reply: { status: number; body: object }) {
  const posted: Array<Record<string, string>> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posted.push({ url, ...Object.fromEntries(new URLSearchParams(init.body as string)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return posted;
}

const call = (path: string, body?: object, origin = APP, method = 'POST') =>
  handle(new Request(`https://garmin-maps-auth.example.workers.dev${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);

afterEach(() => vi.unstubAllGlobals());

describe('sealing', () => {
  test('a sealed key opens again; a tampered one or another helper\'s does not', async () => {
    const s = await seal(env, 'refresh-123');
    expect(s.startsWith('v1.')).toBe(true);
    expect(s).not.toContain('refresh-123');
    expect(await unseal(env, s)).toBe('refresh-123');
    expect(await unseal(env, s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA'))).toBeNull();
    expect(await unseal({ ...env, SEAL_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString('base64') }, s)).toBeNull();
    expect(await unseal(env, 'nonsense')).toBeNull();
    expect(await unseal(env, 42)).toBeNull();
  });
});

describe('the helper', () => {
  test('only the app\'s pages may use it', async () => {
    expect((await call('/health', undefined, 'https://evil.example', 'GET')).status).toBe(403);
    const ok = await call('/health', undefined, APP, 'GET');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect((await call('/token', undefined, APP, 'OPTIONS')).status).toBe(204);
  });

  test('a code becomes a token and a sealed refresh key, with the secret added here', async () => {
    const posted = google({ status: 200, body: { access_token: 'at', expires_in: 3599, refresh_token: 'rt' } });
    const res = await call('/token', { code: 'c0de', redirect_uri: `${APP}/garmin-maps/app/` });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.access_token).toBe('at');
    expect(body.expires_in).toBe(3599);
    expect(await unseal(env, body.sealed)).toBe('rt');
    expect(posted[0]).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', client_id: 'client', client_secret: 'secret', redirect_uri: `${APP}/garmin-maps/app/` });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('a return address on another site, or a bad code, is refused', async () => {
    google({ status: 400, body: { error: 'invalid_grant' } });
    expect((await call('/token', { code: 'c', redirect_uri: 'https://evil.example/' })).status).toBe(400);
    expect(await (await call('/token', { code: 'c', redirect_uri: `${APP}/x/` })).json()).toEqual({ error: 'bad_code' });
  });

  test('refresh: a new token; a withdrawn key signs out; Google trouble is not a sign-out', async () => {
    const sealed = await seal(env, 'rt');
    const posted = google({ status: 200, body: { access_token: 'at2', expires_in: 3600 } });
    expect(await (await call('/refresh', { sealed })).json()).toEqual({ access_token: 'at2', expires_in: 3600 });
    expect(posted[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt', client_secret: 'secret' });
    google({ status: 400, body: { error: 'invalid_grant' } });
    expect((await call('/refresh', { sealed })).status).toBe(401);
    google({ status: 500, body: {} });
    expect((await call('/refresh', { sealed })).status).toBe(502);
    expect((await call('/refresh', { sealed: 'v1.junk' })).status).toBe(401);
  });

  test('revoke withdraws the refresh key at Google', async () => {
    const posted = google({ status: 200, body: {} });
    expect((await call('/revoke', { sealed: await seal(env, 'rt') })).status).toBe(204);
    expect(posted[0]).toMatchObject({ url: 'https://oauth2.googleapis.com/revoke', token: 'rt' });
  });
});
