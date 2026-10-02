import { afterEach, describe, expect, test, vi } from 'vitest';
import { AUTH_HELPER, authUrl, exchangeCode, HelperError, refreshToken, signInReturn, withoutSignInReturn } from '../src/sync/helper';

const APP = 'https://atlipall.github.io/garmin-maps/app/';

/** A fake helper: answers each path with a status and body; records the calls. */
function helper(replies: Record<string, { status: number; body?: object } | 'down'>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.slice(AUTH_HELPER.length);
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : null });
    const r = replies[path];
    if (!r || r === 'down') throw new TypeError('Failed to fetch');
    return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('the sign-in page and its return', () => {
  test('Google is asked for consent and a refresh key, coming back to the app', () => {
    const u = new URL(authUrl({ clientId: 'cid', scope: 'https://www.googleapis.com/auth/drive.appdata', redirect: APP, state: 's1' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid', redirect_uri: APP, response_type: 'code', access_type: 'offline', prompt: 'consent', state: 's1' });
  });

  test('the return is read (code or error) and tidied out of the address, keeping the rest', () => {
    const back = `${APP}?code=4%2F0Ab&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata&state=s1&authuser=0&prompt=consent#x`;
    expect(signInReturn(back)).toEqual({ code: '4/0Ab', state: 's1' });
    expect(signInReturn(`${APP}?error=access_denied&state=s1`)).toEqual({ error: 'access_denied', state: 's1' });
    expect(signInReturn(APP)).toBeNull();
    expect(withoutSignInReturn(back)).toBe(`${APP}#x`);
    expect(withoutSignInReturn(`${APP}?map=1&code=c&state=s`)).toBe(`${APP}?map=1`);
  });
});

describe('the helper client', () => {
  test('a code becomes a token running out in an hour, and the sealed key', async () => {
    const calls = helper({ '/token': { status: 200, body: { access_token: 'at', expires_in: 3600, sealed: 'v1.x' } } });
    const before = Date.now();
    const t = await exchangeCode('c0de', APP);
    expect(t.token).toBe('at');
    expect(t.sealed).toBe('v1.x');
    expect(t.expires).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(calls).toEqual([{ path: '/token', body: { code: 'c0de', redirect_uri: APP } }]);
  });

  test('a refused key signs out; a helper that is down or failing is only unreachable', async () => {
    helper({ '/refresh': { status: 401, body: { error: 'signed_out' } } });
    await expect(refreshToken('v1.x')).rejects.toMatchObject({ kind: 'signed-out' });
    helper({ '/refresh': { status: 502, body: { error: 'google' } } });
    await expect(refreshToken('v1.x')).rejects.toMatchObject({ kind: 'unreachable' });
    helper({ '/refresh': 'down' });
    const err = await refreshToken('v1.x').catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect(err.kind).toBe('unreachable');
  });
});
