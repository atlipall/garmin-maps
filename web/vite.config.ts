import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import { stampServiceWorker } from './scripts/precache.ts';
import type { Build } from './src/buildInfo.ts';

/** The development version (VITE_CHANNEL=dev, deployed to /garmin-maps/app-dev/; see src/channel.ts). */
const DEV = process.env.VITE_CHANNEL === 'dev';

/** After the bundle (and the public/ copy) is written: in the development version, name it so on
 *  the Home Screen (before the files are hashed); then stamp sw.js with the list of built files, a
 *  cache name derived from them and the build stamp (see scripts/precache.ts). */
function precacheServiceWorker(build: Build): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'garmin-precache-sw',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    transformIndexHtml(html) {
      return DEV ? html.replace('<title>Garmin Map</title>', '<title>Garmin Map Dev</title>') : html;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      if (DEV) await markDevManifest(join(outDir, 'manifest.webmanifest'));
      const { cache, count } = await stampServiceWorker(outDir, build);
      config.logger.info(`sw.js: precaching ${count} files as ${cache}`);
    },
  };
}

/** The development version's Home Screen name and colour, so it isn't mistaken for the app. */
async function markDevManifest(path: string): Promise<void> {
  const m = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...m, name: 'Garmin Map Dev', short_name: 'Map Dev', theme_color: '#7c3aed' }, null, 2));
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

export default defineConfig(({ command }) => {
  // One stamp for the page and the service worker: shown at the bottom of the ⋯ menu, so a phone can
  // tell which deploy it runs, and compared to tell a newer version is installed.
  const build: Build = { version: command === 'build' ? commitId() : 'dev', builtAt: new Date().toISOString() };
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(build.version),
      __BUILD_TIME__: JSON.stringify(build.builtAt),
    },
    // The app is served from /garmin-maps/app/ (the development version from /garmin-maps/app-dev/);
    // the site root (instructions page) comes from site/.
    build: { outDir: DEV ? 'dist/app-dev' : 'dist/app', emptyOutDir: true },
    worker: { format: 'es' },
    plugins: [precacheServiceWorker(build)],
    // maplibre-gl locates its own worker script via `import.meta.url`; excluding it from the
    // dependency optimizer keeps that URL pointing at node_modules (where the worker file lives
    // next to the main bundle) instead of the .vite/deps cache (where it does not), which
    // otherwise 404s and breaks map rendering in the dev server.
    optimizeDeps: { exclude: ['maplibre-gl'] },
    test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
  };
});
