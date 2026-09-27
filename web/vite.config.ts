import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // maplibre-gl locates its own worker script via `import.meta.url`; excluding it from the
  // dependency optimizer keeps that URL pointing at node_modules (where the worker file lives
  // next to the main bundle) instead of the .vite/deps cache (where it does not), which
  // otherwise 404s and breaks map rendering in the dev server.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
