/**
 * Passes the free Freizeitkarte map of Iceland (an OpenStreetMap-based Garmin map, "free for any
 * purposes", freizeitkarte-osm.de) through to the app. The browser can't fetch it from there itself:
 * that server doesn't send the headers a web page needs (CORS). This adds them, for the app's own
 * pages only (ALLOWED_ORIGINS), and for that one file only: it is not a general proxy. Nothing is
 * stored; Range requests are passed on.
 *
 *   GET|HEAD /iceland.zip   the zip (one entry, gmapsupp.img), status and size as the source sends
 */

export interface Env {
  /** Comma-separated origins, e.g. "https://atlipall.github.io". */
  ALLOWED_ORIGINS: string;
}

export const SOURCE = 'https://download.freizeitkarte-osm.de/garmin/latest/ISL_en_gmapsupp.img.zip';
/** Headers of the source's reply that the app may read. */
const PASSED = ['Content-Length', 'Content-Range', 'Content-Type', 'Last-Modified', 'ETag', 'Accept-Ranges'];

export async function handle(req: Request, env: Env): Promise<Response> {
  const origins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') ?? '';
  if (!origins.includes(origin)) return new Response('origin', { status: 403, headers: { Vary: 'Origin' } });
  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': PASSED.join(', '),
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method', { status: 405, headers });
  if (new URL(req.url).pathname !== '/iceland.zip') return new Response('not found', { status: 404, headers });

  const range = req.headers.get('Range');
  let res: Response;
  try {
    res = await fetch(SOURCE, { method: req.method, headers: range ? { Range: range } : {} });
  } catch {
    return new Response('source unreachable', { status: 502, headers });
  }
  for (const h of PASSED) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

export default { fetch: handle };
