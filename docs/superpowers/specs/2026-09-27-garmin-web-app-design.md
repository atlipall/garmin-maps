# On-the-fly Garmin map web app: design

Date: 2026-09-27
Status: approved in brainstorming. Next step: an implementation plan whose first task is a performance spike.

## Goal

View the GPSmap.is Garmin IMG maps offline on the iPhone and the Mac. The app decodes and renders the IMG file directly, on the fly, with no pre-rendered tiles. The main use is in the field on the iPhone, following your GPS position.

This replaces "phase 2" of the converter spec (`2026-09-27-garmin-img-to-mbtiles-design.md`). The raster MBTiles produced by the converter stay useful as a fallback.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Platform | A web app (installable PWA) running in Safari on iPhone and Mac | Xcode is not installed, and MapLibre ships no macOS binary. A web app covers both devices with no Xcode. |
| Map engine | MapLibre GL JS | It handles label placement, gestures and styling, and it reads the style format the converter already generates |
| Decoder | A TypeScript port of the Python `imgconv` decoder | The Python decoder is verified on the real files (2M features, 0 bad sections) |
| v1 features | On-the-fly map, hillshade, offline use, GPS position with follow, place-name search | Chosen by the user |
| Deferred | GPX overlay and recording, switching between variants, background tracking, routing | Chosen by the user |
| Hosting | GitHub Pages, deployed by a GitHub Action | Chosen by the user. The repo must be public on the free plan. Map and DEM files are gitignored and never uploaded. |
| Build | Vite, TypeScript, Vitest | Standard, fast, and no framework lock-in |

## Inputs (on the user's devices only)

- One Garmin IMG file, for example `Iceland GPSmap.is 2024.21 Detailed.img` (about 100 MB). It is unscrambled, has 5 map tiles, 8-bit cp1252 labels and a TYP style.
- 48 SRTM3 `.hgt` files covering N63–N66 × W14–W25 (about 138 MB in total).

The user imports these once through a file picker (from the Files app on iPhone, or Finder on Mac). They are stored in the browser's origin-private file system (OPFS). The app requests persistent storage.

## Architecture

```
IMG + HGT files (OPFS) ──▶ Web Worker pool ──▶ MapLibre GL JS
                            ▲ garmin://{z}/{x}/{y}  vector tiles (MVT), built on demand
                            ▲ dem://{z}/{x}/{y}     terrain-RGB PNG, built on demand
                            style + icons/patterns: generated at load from the TYP
                            glyphs: bundled with the app (Noto Sans Regular/Italic)
```

The app lives in `web/` in this repo. Its modules:

- **`img/`**: a TypeScript port of `imgconv`: `container`, `bitstream`, `tre`, `rgn`, `lbl` and `typ`. It carries over every fix and ruling from the converter:
  - 24-bit RGN offsets are unwrapped.
  - The FAT part order is validated, and the FAT scan continues past gaps.
  - Locking is detected only via TRE flag 0x0D & 0x80.
  - A misaligned section drops all of its objects and is counted.
  - Label parts are tagged with the separator that precedes them, and a 0x1F elevation in feet becomes metres.
  - Contour labels are converted from feet to metres.

  It reads byte ranges from the OPFS file on demand. The whole IMG is never held in memory.
- **`tiles/`**: the vector tile builder.
  - At load it builds a spatial index of subdivision bounding boxes, one per level.
  - For tile z/x/y (MapLibre zoom) it picks the level using the converter's `zoom_bands` rule (`minzoom = bits − 11`, clamped to 4–14, with the coarsest level that has data starting at 4). It then decodes only the subdivisions that intersect the tile, plus a buffer.
  - Decoded subdivisions are kept in an LRU cache.
  - Features are clipped to the tile and buffer, projected to tile coordinates and encoded as MVT. The layers are `points`, `lines` and `polygons`, with properties `t` (the Garmin type as an integer) and `name`, matching the converter.
  - Tiles are served to MapLibre through `maplibregl.addProtocol("garmin", …)` and built in a pool of workers.
- **`dem/`**: builds terrain-RGB tiles (mapbox encoding) on demand at z5–11 with tileSize 256, using the same maths as `imgconv/hillshade.py`: bilinear sampling, voids and negative heights set to 0, `v = round((h+10000)*10)`. Workers read only the HGT rows each tile needs, straight from OPFS. The tiles are served through `addProtocol("dem", …)`.
- **`style/`**: a port of `stylegen.py` and `fallback_styles.py`. It builds the MapLibre style at load from the TYP: polygon draw levels, the hillshade layer, line casings and lines, labels, POI icons and circles. Patterns and icons are added with `map.addImage` rather than a sprite file. Glyphs are served from the app.
- **`search/`**: an index of names built in a worker after load:
  - named points from the finest level;
  - named polygons and lines, deduplicated by name and rounded position.

  It is cached in IndexedDB, keyed by the IMG's size and modification time. Queries are prefix and diacritic-insensitive (so "thorsmork" matches "Þórsmörk"). Picking a result flies the map to that spot.
- **UI**:
  - a full-screen map;
  - a locate/follow button: a blue dot with an accuracy circle, a heading arrow when the device reports one, and follow mode that turns off when the user pans;
  - a search box;
  - a small status badge showing decode warnings;
  - a first-run import screen.
- **PWA**: a web manifest and a service worker that precaches the app shell and the glyphs, so the app starts offline and can be added to the Home Screen.
- **Deployment**: a GitHub Action builds `web/` and publishes it to GitHub Pages. Creating the GitHub repo and making it public is confirmed with the user before it happens.

## Performance targets

- A z14 vector tile in dense Reykjavík builds in a worker in under 100 ms on the Mac. The iPhone is measured separately.
- Opening a stored IMG (FAT, TRE, LBL and TYP headers, plus the spatial index) takes under 2 s.
- Panning and zooming feels smooth on the iPhone at z10–15.
- Memory stays bounded by the caches; there are no whole-file reads.

The implementation starts with a **spike**: `img/`, `tiles/` and a bare MapLibre page, in desktop Safari, on the real Detailed IMG, with timing measured. It continues only if these targets are close. If they are not, the fallbacks are:
- pre-computing the per-level index into IndexedDB at import;
- coarser tile caching;
- decoding into a persistent per-tile cache.

## Correctness and testing

- **Unit tests (Vitest):** the byte fixtures from the Python tests are ported with the same expected values: bitstream, TRE, RGN, LBL, TYP, zoom bands and terrain-RGB.
- **Golden cross-check:** decode the real IMG with the TypeScript decoder and compare it with the Python decoder's output for the same file (`out/<variant>/features.geojsonseq`, `types.json`, `decode-stats.json`). Compare the per-tile and per-layer feature counts, and sample coordinates and names. The test is skipped when the data is absent.
- **Tile tests:** a tile covering Reykjavík contains the expected named features, and clipped geometries stay within the tile extent plus buffer.
- **Visual check:** use headless Chrome to screenshot the app at the four sample locations (Reykjavík z15, Landmannalaugar z13, Vatnajökull z11, Iceland z7) and compare them with the converter's raster samples. The user reviews them before deployment.

## Error handling

- **At import:** a locked tile, an unsupported label encoding, a missing subfile or a corrupt header shows a clear message naming the tile and subfile (for example `14057403.TRE: …`), and no map opens. This is the same fail-loud rule as the converter.
- **At runtime:** if a subdivision fails to decode, that area is left blank, the error is counted and logged, and a warning badge appears. The app does not crash.
- **Storage:** if files have been evicted or are missing, the app returns to the import screen with an explanation.
- **Location:** if permission is denied or unavailable, the locate button is disabled and shows a hint.

## Out of scope (v1)

- GPX import, export and recording.
- Switching between variants: one IMG is loaded at a time, and loading another replaces it.
- Background location.
- Routing (NET/NOD) and address search (MDR).
- Native iOS or macOS apps.
- Editing.

## Known limitations

- iOS Safari may evict PWA storage after long disuse. The app detects this and asks for the files again.
- Location works only while the app is in the foreground.
