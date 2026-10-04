# Garmin Map: notes for working on this repo

A web app (TypeScript, Vite, MapLibre) that draws Garmin `.img` maps offline in the browser, used as an
iPhone Home Screen app, on a Mac, and on an Android car head unit. See README.md for the layout. The owner
is the only user and tests on an iPhone 13 and the head unit.

## How the owner likes to work

- **Small fixes: deploy right away** once unit tests and the e2e pass (push `main`). **Larger features:
  build on a branch**, put it on the development site (below) for a phone test, and merge and deploy
  when the owner says so.
- **Mockups first** for new UI when asked: a Design artifact with phone-sized screens (390×844).
- Ask the few questions that change the design (one `AskUserQuestion` with options), then build.
- **No money:** free tiers only (GitHub Pages, Cloudflare Workers free plan, Google APIs free quotas).
- **The app must work offline**; anything online (sync, downloads) is optional and fails softly.
- Copy is plain and specific, from the user's side ("Save as track", "Off the track · 180 m from it").
- PR descriptions: no "Test plan" section (owner's global rule).
- Commit messages explain what and why; end them with the Claude-Session link.

## Commands (run in `web/`)

```bash
./node_modules/.bin/tsc --noEmit        # typecheck (npx is blocked by a hook; use node_modules/.bin)
./node_modules/.bin/vitest run          # unit tests (~290); real-data tests need the GPSmap.is package
npm run e2e                             # build with VITE_GOOGLE_CLIENT_ID=e2e, then the full headless-Chrome run (~5 min)
node scripts/e2e.mjs                    # the e2e again without rebuilding
npm run dev                             # http://localhost:5173
npm run shots                           # retake the guide's screenshots (web/site/images/) after a UI change
```

- **`npm install` is blocked** unless logged in to npm (`npm login`): no new dependencies without asking.
  Prefer writing small code over adding packages (zip, Shapefile and projections were written by hand).
- The e2e drives the real map from `GPSmap.is 2024.21 Android/` (never committed), fakes GPS with
  `Emulation.setGeolocationOverride`, and fakes Google Drive, the sign-in helper and HMS with request
  interception. A failed click reports its line and which parent was hidden. Screenshots go to
  `web/e2e-output/`; look at them, they catch what assertions miss.
- Tests that build a vector tile should decode it and check the geometry, not just the properties.

## Deployments

| What | Where | How |
|---|---|---|
| The app + guide | atlipall.github.io/garmin-maps/ (`/app/`) | push `main` → `.github/workflows/pages.yml` |
| Development version | `/garmin-maps/app-dev/` ("Map Dev") | `git push --force origin <branch>:dev`; `dev.yml` re-runs Pages from main, which builds both |
| Android app | GitHub Releases, `releases/latest/download/GarminMap.apk` | push `main` touching `android/` → `android.yml` |
| Sign-in helper | garmin-maps-auth.atlipall.workers.dev | `wrangler deploy` in `web/auth-worker/` |
| Asset links | atlipall.github.io/.well-known/assetlinks.json | repo `atlipall/atlipall.github.io` |
| Development page | atlipall.github.io/garmin-maps/dev/ (APK downloads, short to type on the head unit) | `web/site/dev/index.html`, deployed with the site; update its pinned APK version |

- Only `main` may deploy to Pages (environment rule): never loosen it; dev deploys go through `dev.yml`.
- **The development version keeps its own storage** (`web/src/channel.ts`, build flag `VITE_CHANNEL=dev`):
  database, settings, map folder, caches and sync file all differ, so a new storage format there can't
  break the app. Every storage name goes through `storageName()` / `storageRoot()`.
- **IndexedDB is opened at whatever version it has** (`web/src/storage/idb.ts`); add a store by adding it
  to `STORES`, never by relying on a version number (branches and old app versions share databases).
- **Adding a host the app talks to:** add it to the CSP `connect-src` in `web/index.html`, or it fails
  silently in the browser (the e2e catches it; unit tests don't).
- Wrangler isn't installed globally: use `/Users/atli/projects/katifillinn/node_modules/.bin/wrangler`
  (logged in to the owner's Cloudflare account, workers.dev subdomain `atlipall`). Its secrets:
  `GOOGLE_CLIENT_SECRET`, `SEAL_KEY`.
- Android: no Android SDK or JDK on this Mac; APKs are built on GitHub. Signing key: repo secrets
  `ANDROID_KEYSTORE`/`ANDROID_KEYSTORE_PASSWORD`, local copy in `.android-signing/` (git-ignored; never
  lose it, or updates stop installing over the old app).

## Open work (update this when it changes)

- **`tracks-nav` branch** (on the dev site): routes saved as tracks, the track card, navigating a track
  (to its nearest point ahead, then along it; imported tracks matched to roads, trail bends as turns).
  Waiting for the owner to try it; merge to `main` when they say so.
- **`map-layers` branch** (paused by the owner): imported GeoJSON/Shapefile layers and HMS farm
  boundaries. Next idea if resumed: HMS estimated boundaries (`HMS_AETLUN_SKIKI`) as dashed lines.
- **Android app doesn't run on the head unit** (1.3, Trusted Web Activity). Waiting for the owner to
  say what happens and to try 1.1 (WebView only, `releases/download/android-1.1/GarminMap.apk`, needs
  an uninstall first). If 1.1 fails too, install the Android tools and reproduce in an emulator.
- Import screen tip is iOS-only ("Share → Add to Home Screen"); Android would need its own.
