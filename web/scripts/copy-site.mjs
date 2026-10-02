import { cp } from 'node:fs/promises';

// The site root (/garmin-maps/): the instructions page and the sw.js that retires the old root
// app's service worker. Vite builds the app itself into dist/app/ (see vite.config.ts).
// The development version (VITE_CHANNEL=dev) is only the app: the site root comes from main's build.
if (process.env.VITE_CHANNEL === 'dev') {
  console.log('development version: site/ not copied');
} else {
  await cp(new URL('../site/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
  console.log('copied site/ to dist/');
}
