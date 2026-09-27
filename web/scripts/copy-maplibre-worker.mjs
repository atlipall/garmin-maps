import { cp } from 'node:fs/promises';

// maplibre-gl locates its own tile-processing worker at runtime via
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)`, resolved relative to wherever its own
// bundled code ends up (Vite inlines maplibre-gl's module into our main chunk under dist/assets/).
// That reference isn't a static `new Worker(new URL(...))` call Vite's build can see and bundle
// (unlike our own tileWorker/storageWorker), so the production build never includes it. It 404s
// (as HTML, via vite preview's SPA fallback), which makes maplibre's own worker fail to load and
// permanently breaks map rendering — style and tiles never finish loading. Copying the two files
// it needs into public/assets/ so Vite's plain static-file copy places them next to the built
// bundle, at dist/assets/, fixes that.
const dist = new URL('../node_modules/maplibre-gl/dist/', import.meta.url);
const dst = new URL('../public/assets/', import.meta.url);
for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  await cp(new URL(name, dist), new URL(name, dst));
  console.log('copied', name);
}
