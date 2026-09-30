import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import { stampServiceWorker } from './scripts/precache.ts';

/** After the bundle (and the public/ copy) is written, stamp dist/app/sw.js with the list of built
 *  files and a cache name derived from them (see scripts/precache.ts). */
function precacheServiceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'garmin-precache-sw',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const { cache, count } = await stampServiceWorker(outDir);
      config.logger.info(`sw.js: precaching ${count} files as ${cache}`);
    },
  };
}

/** The commit being built: GitHub Actions' GITHUB_SHA on deploys, else the local checkout's HEAD. */
function commitId(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ command }) => ({
  base: './',
  // Shown at the bottom of the ⋯ menu, so a phone can tell which deploy it runs.
  define: {
    __APP_VERSION__: JSON.stringify(command === 'build' ? commitId() : 'dev'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // The app is served from /garmin-maps/app/; the site root (instructions page) comes from site/.
  build: { outDir: 'dist/app', emptyOutDir: true },
  worker: { format: 'es' },
  plugins: [precacheServiceWorker()],
  // maplibre-gl locates its own worker script via `import.meta.url`; excluding it from the
  // dependency optimizer keeps that URL pointing at node_modules (where the worker file lives
  // next to the main bundle) instead of the .vite/deps cache (where it does not), which
  // otherwise 404s and breaks map rendering in the dev server.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
}));
