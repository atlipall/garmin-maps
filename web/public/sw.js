/* Offline support: precache the whole app shell; cache everything else same-origin on first use.
 *
 * `npm run build` rewrites the two placeholders below (scripts/precache.ts, run by the Vite plugin
 * in vite.config.ts): CACHE becomes `garmin-app-<hash of the built files>` and PRECACHE lists every
 * built file, so each deploy installs a fresh complete copy and `activate` drops the old one. The
 * defaults keep an unbuilt copy (dev) working. */
const CACHE = self.__CACHE__ || 'garmin-app-dev';
/** Caches this app owns. Others on the origin (other sites under atlipall.github.io, and the
 *  pre-/app/ root app's `garmin-map-*` caches, which the root sw.js retires) are left alone. */
const OWN = 'garmin-app-';
const FONTS = ['Noto Sans Regular', 'Noto Sans Italic'].flatMap((f) =>
  ['0-255', '256-511', '8192-8447'].map((r) => `./fonts/${encodeURIComponent(f)}/${r}.pbf`));
const PRECACHE = [...new Set([
  ...(self.__PRECACHE__ || ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']),
  ...FONTS,
])];
/** How long a navigation waits for the network before serving the cached shell. */
const NAV_TIMEOUT_MS = 3000;

/** Remembers the app's last two caches, newest last (a cache outside OWN, so it survives). */
const ORDER = 'garmin-app-order-v1';

const cacheable = (res) => res && res.ok && res.type === 'basic';
/** A cached response, from this version's cache first, else an older one still kept. */
const cached = (req) => caches.open(CACHE).then((c) => c.match(req)).then((hit) => hit || caches.match(req));
const put = (key, res) => caches.open(CACHE).then((c) => c.put(key, res)).catch(() => {});

self.addEventListener('install', (e) => {
  // `cache: 'reload'` bypasses the HTTP cache so a new build never precaches stale files.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

// The previous version's cache stays until the next update: a page still running the old version
// (an iPhone Home Screen app can for days) can then still load its files, such as a worker it starts
// later (importing a map, or a map worker restarted after a crash). Older ones are dropped.
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const order = await caches.open(ORDER);
    const had = await order.match('order').then((r) => (r ? r.json() : []), () => []);
    const keep = [...had.filter((k) => k !== CACHE), CACHE].slice(-2);
    await order.put('order', new Response(JSON.stringify(keep)));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(OWN) && k !== ORDER && !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Race the network against a timeout so a flaky connection in the field can't hang startup;
    // whichever way it goes, a good network response still refreshes the cached shell.
    let refresh = Promise.resolve();
    const net = fetch(req).then((res) => {
      if (cacheable(res)) refresh = put('./', res.clone());
      return res;
    });
    e.waitUntil(net.then(() => refresh).catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
    e.respondWith((async () => {
      const res = await Promise.race([net.catch(() => null), timeout]);
      if (res && res.ok) return res;
      const cached = await caches.open(CACHE).then((c) => c.match('./'));
      if (cached) return cached;
      return res || net; // no cached shell: wait for (or fail with) the network
    })());
    return;
  }

  e.respondWith(cached(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (cacheable(res)) put(req, res.clone());
      return res;
    });
    if (hit) {
      net.catch(() => {}); // background refresh; offline is expected here
      return hit;
    }
    return net;
  }));
});
