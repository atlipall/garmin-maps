/**
 * Staying signed in to Google for Drive sync, through the sign-in helper (auth-worker/worker.ts).
 *
 * Signing in goes to Google's own page and back (a redirect, so Google can be asked for the consent
 * that comes with a lasting refresh key on every device); the one-time code that comes back is traded
 * by the helper for an access token and the refresh key, sealed so only the helper can use it. The
 * device keeps the sealed key and gets a new token from the helper whenever the last one runs out.
 * Without the helper (unreachable, or not configured), sync signs in for an hour at a time instead.
 */

/** The helper's address, or VITE_AUTH_HELPER at build time ('' turns it off). */
export const AUTH_HELPER: string = import.meta.env.VITE_AUTH_HELPER ?? 'https://garmin-maps-auth.atlipall.workers.dev';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
/** How long to wait for the helper before treating it as unreachable. */
const TIMEOUT_MS = 8000;

export interface HelperToken {
  token: string;
  /** When it runs out (ms). */
  expires: number;
  /** The sealed refresh key (from a sign-in); none: Google gave no refresh key. */
  sealed?: string;
}

/** `signed-out`: the refresh key no longer works (withdrawn or expired); `unreachable`: try later. */
export class HelperError extends Error {
  constructor(readonly kind: 'signed-out' | 'unreachable' | 'refused', message: string) {
    super(message);
  }
}

async function post(path: string, body: object): Promise<Response> {
  try {
    return await fetch(AUTH_HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HelperError('unreachable', "Couldn't reach the sign-in helper.");
  }
}

const toToken = (r: { access_token: string; expires_in?: number; sealed?: string | null }, now = Date.now()): HelperToken => ({
  token: r.access_token,
  expires: now + (r.expires_in ?? 3600) * 1000,
  ...(r.sealed ? { sealed: r.sealed } : {}),
});

/** Whether the helper answers (checked before leaving for Google's page). */
export async function helperReachable(): Promise<boolean> {
  if (!AUTH_HELPER) return false;
  try {
    return (await fetch(`${AUTH_HELPER}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** Google's sign-in page, asking for consent so a refresh key comes back too. */
export function authUrl(o: { clientId: string; scope: string; redirect: string; state: string }): string {
  const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirect, response_type: 'code', scope: o.scope, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: o.state });
  return `${GOOGLE_AUTH}?${q}`;
}

/** What Google's page sent back in the app's address: a code, an error, or nothing (a normal start). */
export function signInReturn(href: string): { code: string; state: string } | { error: string; state: string } | null {
  const q = new URL(href).searchParams;
  const state = q.get('state') ?? '';
  if (q.get('code')) return { code: q.get('code')!, state };
  if (q.get('error')) return { error: q.get('error')!, state };
  return null;
}

/** The app's address without what Google added (code, state, scope…). */
export function withoutSignInReturn(href: string): string {
  const url = new URL(href);
  for (const k of ['code', 'state', 'scope', 'error', 'authuser', 'prompt', 'hd', 'iss']) url.searchParams.delete(k);
  return url.toString();
}

/** Trades the code from Google's page for a token and the sealed refresh key. */
export async function exchangeCode(code: string, redirect: string): Promise<HelperToken> {
  const res = await post('/token', { code, redirect_uri: redirect });
  if (res.status === 400) throw new HelperError('refused', 'Google sign-in did not go through; try again.');
  if (!res.ok) throw new HelperError('unreachable', "Couldn't reach the sign-in helper.");
  return toToken(await res.json());
}

/** A new token for the sealed refresh key. */
export async function refreshToken(sealed: string): Promise<HelperToken> {
  const res = await post('/refresh', { sealed });
  if (res.status === 401) throw new HelperError('signed-out', 'Sign in again to keep syncing.');
  if (!res.ok) throw new HelperError('unreachable', "Couldn't reach the sign-in helper.");
  return toToken(await res.json());
}

/** Withdraws the sealed refresh key at Google (best effort: Stop syncing doesn't wait for it). */
export function revokeSealed(sealed: string): void {
  if (!AUTH_HELPER) return;
  fetch(`${AUTH_HELPER}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sealed }), keepalive: true }).catch(() => {});
}
