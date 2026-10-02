/**
 * The sign-in helper for Drive sync: a Cloudflare Worker that lets the app stay signed in to Google.
 *
 * A web page can't keep a client secret, so on its own it only gets access tokens that last an hour.
 * This holds the secret: it trades the one-time code from Google's sign-in page for an access token
 * and a refresh key, and later trades the refresh key for new access tokens. It stores nothing: the
 * refresh key goes back to the device sealed (AES-GCM with SEAL_KEY), and only this helper can open
 * it. Only the app's own pages may call it (ALLOWED_ORIGINS).
 *
 *   GET  /health                          204, to tell whether it's reachable
 *   POST /token   {code, redirect_uri}    {access_token, expires_in, sealed}
 *   POST /refresh {sealed}                {access_token, expires_in}; 401 {error: 'signed_out'}
 *   POST /revoke  {sealed}                204 (the refresh key is withdrawn at Google)
 */

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 32 bytes, base64. */
  SEAL_KEY: string;
  /** Comma-separated origins, e.g. "https://atlipall.github.io". */
  ALLOWED_ORIGINS: string;
}

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
/** Ties a sealed key to its purpose (and the format's version). */
const SEAL_CONTEXT = new TextEncoder().encode('garmin-maps refresh key v1');
const SEAL_PREFIX = 'v1.';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sealKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', unb64(env.SEAL_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The refresh key, sealed for the device to keep: "v1." + base64url(iv ‖ ciphertext). */
export async function seal(env: Env, refreshKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: SEAL_CONTEXT }, await sealKey(env), new TextEncoder().encode(refreshKey)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return SEAL_PREFIX + b64(out);
}

/** The refresh key inside a sealed one; null when it isn't one this helper sealed. */
export async function unseal(env: Env, sealed: unknown): Promise<string | null> {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEAL_PREFIX)) return null;
  try {
    const bytes = unb64(sealed.slice(SEAL_PREFIX.length));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: SEAL_CONTEXT }, await sealKey(env), bytes.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

interface GoogleToken { access_token?: string; expires_in?: number; refresh_token?: string; error?: string }

async function google(env: Env, params: Record<string, string>): Promise<{ status: number; body: GoogleToken }> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as GoogleToken };
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const origins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') ?? '';
  const allowed = origins.includes(origin);
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  const reply = (status: number, body?: object) =>
    new Response(body ? JSON.stringify(body) : null, { status, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers });

  if (!allowed) return reply(403, { error: 'origin' });
  if (req.method === 'OPTIONS') return reply(204);
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/health') return reply(204);
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return reply(400, { error: 'bad_request' });

  try {
    if (path === '/token') {
      const { code, redirect_uri: redirect } = body;
      // The return address must be one of the app's own pages (Google checks it is registered, too).
      if (typeof code !== 'string' || typeof redirect !== 'string' || !origins.includes(new URL(redirect).origin)) return reply(400, { error: 'bad_request' });
      const g = await google(env, { grant_type: 'authorization_code', code, redirect_uri: redirect });
      if (g.status !== 200 || !g.body.access_token) return reply(400, { error: 'bad_code' });
      return reply(200, { access_token: g.body.access_token, expires_in: g.body.expires_in ?? 3600, sealed: g.body.refresh_token ? await seal(env, g.body.refresh_token) : null });
    }
    if (path === '/refresh') {
      const key = await unseal(env, body.sealed);
      if (!key) return reply(401, { error: 'signed_out' });
      const g = await google(env, { grant_type: 'refresh_token', refresh_token: key });
      // Withdrawn (Stop syncing elsewhere, or removed in the Google account) or expired.
      if (g.body.error === 'invalid_grant') return reply(401, { error: 'signed_out' });
      if (g.status !== 200 || !g.body.access_token) return reply(502, { error: 'google' });
      return reply(200, { access_token: g.body.access_token, expires_in: g.body.expires_in ?? 3600 });
    }
    if (path === '/revoke') {
      const key = await unseal(env, body.sealed);
      if (key) await fetch(GOOGLE_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: key }) });
      return reply(204);
    }
  } catch {
    return reply(502, { error: 'google' });
  }
  return reply(404, { error: 'not_found' });
}

export default { fetch: handle };
