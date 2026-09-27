# GPSmap.is → MBTiles

Converts the GPSmap.is Garmin IMG maps (made for OruxMaps on Android) into raster MBTiles with hillshade,
for offline use in iOS map apps that open MBTiles (for example Guru Maps).

## Setup

```bash
brew install tippecanoe
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
(cd render && npm install)
```

## Convert a map

```bash
.venv/bin/imgconv convert "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
```

The result is `out/<variant>/<variant>.mbtiles` (raster zooms 5–15). AirDrop it to the iPhone and open it with
the map app. Rendering is resumable: re-running `imgconv render` continues where it stopped.

Individual stages: `inspect`, `decode`, `style`, `tiles`, `dem`, `sample`, `render` (`imgconv --help`).

## Tests

```bash
.venv/bin/pytest            # tests marked realdata use the GPSmap.is files when present
(cd render && npm test)
```

## Phase 2 notes

- `style.json` uses private URL schemes — `mbtiles://vector|dem/{z}/{x}/{y}`, `fonts://{fontstack}/{range}.pbf`,
  and `sprite://sprite` — resolved by `render/lib/renderer.mjs`. A MapLibre iOS app must rewrite these to its
  own tile/glyph/sprite sources before loading the style.
- The sprite is 1x only.
- Vector tiles use MapLibre zoom (z4-14); the DEM is terrain-RGB (Mapbox encoding) at z5-11 with tileSize 256.
- Labels are placed per 8x8 metatile, so a label can occasionally be clipped at a metatile edge.

## Web app (on-the-fly, iPhone and Mac)

`web/` is a browser app that renders the Garmin `.img` directly, with no pre-rendered tiles. It adds hillshade from the `.hgt` files, place search and GPS, and works offline once installed.

```bash
cd web && npm install
npm run dev        # http://localhost:5173
npm test           # unit + golden tests (golden tests need the GPSmap.is files and out/ reference data)
npm run e2e        # full headless-Chrome check: import, hillshade, search, offline
```

On the iPhone, open the GitHub Pages URL in Safari, then use Share → Add to Home Screen. Open the app, tap Import, and pick the `.img` and the `.hgt` files from the Files app. They stay on the device.
