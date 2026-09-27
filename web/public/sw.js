/* Offline support: precache the whole app shell; cache everything else same-origin on first use.
 *
 * `npm run build` rewrites the two placeholders below (scripts/precache.ts, run by the Vite plugin
 * in vite.config.ts): CACHE becomes `garmin-map-<hash of the built files>` and PRECACHE lists every
 * built file, so each deploy installs a fresh complete copy and `activate` drops the old one. The
 * defaults keep an unbuilt copy (dev) working. */
const CACHE = self.__CACHE__ || 'garmin-map-dev';
const FONTS = ['Noto Sans Regular', 'Noto Sans Italic'].flatMap((f) =>
  ['0-255', '256-511', '8192-8447'].map((r) => `./fonts/${encodeURIComponent(f)}/${r}.pbf`));
const PRECACHE = [...new Set([
  ...(self.__PRECACHE__ || ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']),
  ...FONTS,
])];
/** How long a navigation waits for the network before serving the cached shell. */
const NAV_TIMEOUT_MS = 3000;

const cacheable = (res) => res && res.ok && res.type === 'basic';
const put = (key, res) => caches.open(CACHE).then((c) => c.put(key, res)).catch(() => {});

self.addEventListener('install', (e) => {
  // `cache: 'reload'` bypasses the HTTP cache so a new build never precaches stale files.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
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
      const cached = await caches.match('./');
      if (cached) return cached;
      return res || net; // no cached shell: wait for (or fail with) the network
    })());
    return;
  }

  e.respondWith(caches.match(req).then((hit) => {
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
