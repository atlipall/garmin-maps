# Garmin Map

A web app that shows Garmin `.img` maps (such as GPSmap.is Iceland) on iPhone and Mac, drawn straight from the
map file in the browser and fully offline: hillshading from SRTM `.hgt` files, place search, GPS follow with
heading-up and ground height, and GPX tracks.

Live at <https://atlipall.github.io/garmin-maps/> (instructions) and <https://atlipall.github.io/garmin-maps/app/>
(the app). The map and elevation files stay on the user's device; nothing is uploaded.

## Development

The app lives in `web/` (TypeScript, Vite, MapLibre GL JS).

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests; real-data tests use the GPSmap.is files when present
npm run typecheck
npm run e2e        # headless-Chrome run on the real map: import, search, location, GPX, offline
```

Tests that need real data look for the GPSmap.is package in `GPSmap.is 2024.21 Android/` at the repo root
(never committed). `npm run build` writes the site to `web/dist/`: the instructions page from `web/site/` at the
root and the app under `app/`.

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`) after typecheck, tests and build.

## Layout

- `web/src/img/`: Garmin IMG reader (container, TRE, RGN, LBL, TYP)
- `web/src/tiles/`, `web/src/style/`: vector tiles built on demand in workers, and the MapLibre style
- `web/src/dem/`: terrain tiles and ground height from `.hgt` files
- `web/src/search/`: place index, descriptions and ranking
- `web/src/location/`, `web/src/app/location.ts`: follow, heading-up, keep screen on
- `web/src/gpx/`, `web/src/app/tracks.ts`: GPX import, storage and drawing
- `web/src/storage/`: storing imported files on the device (OPFS)
- `web/site/`: the instructions page served at the site root
