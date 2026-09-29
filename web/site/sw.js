/* Retires the service worker of the old app, which lived at the site root (/garmin-maps/) before
 * it moved to /garmin-maps/app/. Browsers that still have that worker registered fetch this file
 * on their next update check; it then deletes the old app's caches (garmin-map-*, leaving the new
 * app's garmin-app-* and anything else on the origin alone), unregisters itself and reloads the
 * pages it controlled, so they load fresh from the network. The instructions page at the root
 * registers no service worker, so nothing reinstalls this one. */
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('garmin-map-')).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const pages = await self.clients.matchAll({ type: 'window' });
    await Promise.all(pages.map((p) => p.navigate(p.url).catch(() => {})));
  })());
});
