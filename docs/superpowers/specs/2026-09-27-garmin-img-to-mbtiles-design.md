# Garmin IMG → MBTiles converter — design

Date: 2026-09-27

## Goal

View the GPSmap.is 2024.21 Iceland maps (Garmin IMG, made for OruxMaps on Android) offline on an iPhone in the field, with GPS position.

- **Phase 1 (this spec):** a Mac-side converter producing one raster `.mbtiles` per map variant, z5–z15, with hillshade. It is loaded into an existing offline iOS map app (e.g. Guru Maps).
- **Phase 2 (later, separate spec):** our own SwiftUI iOS/macOS app on MapLibre. It reuses phase 1's vector tiles, style and hillshade.

## Inputs

- `GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/*.img`: four variants (Detailed, Focused, F-Road Detailed, F-Road Focused), ~100 MB each. These are unscrambled Garmin disk images (XOR byte 0, 4096-byte blocks). Each holds 5 map tiles (TRE/RGN/LBL/NET/NOD) plus MDR/MD2/SRT/MPS and one TYP.
- `GPSmap.is 2024.21 Android/HILLSHADE - Add content to DEM folder/*.hgt`: 48 SRTM tiles, N63–N66 × W14–W25.

## Output

- `out/<variant>/iceland-<variant>.mbtiles`: raster tiles, 256 px, z5–z15, ocean-only tiles omitted. Target size 4–6 GB.
- Intermediate files, kept for phase 2 and debugging: `features.geojsonseq`, `vector.mbtiles`, `style.json`, `sprite.{png,json}`, `hillshade.mbtiles`.

## Architecture

Five stages. Each is a separate command that reads and writes files on disk, so it can be re-run and inspected on its own. A `convert` command runs all five stages for one IMG file.

| Stage | Input → Output | Implementation |
|---|---|---|
| decode | IMG → `features.geojsonseq` | Python `imgconv` (new) |
| style | TYP → `style.json`, sprite | Python `imgconv` (new) |
| tile | features → `vector.mbtiles` | tippecanoe |
| hillshade | `.hgt` → `dem.mbtiles` (terrain-RGB) | GDAL (`gdalbuildvrt`, `gdalwarp`, `gdal_calc`, `gdal2tiles`); shaded by MapLibre's `hillshade` layer at render time |
| render | vector + hillshade + style → raster MBTiles | Node, `@maplibre/maplibre-native` |

### Python package `imgconv`

- `container.py`: IMG disk image. Reads the header, the FAT and the subfile extents, and exposes subfiles by name and type.
- `bits.py`: little-endian bit reader, used by RGN geometry and LBL 6-bit labels.
- `tre.py`: bounds, map levels, subdivisions, and polyline/polygon/point overview tables.
- `rgn.py`: points, indexed points, polylines and polygons per subdivision, plus the extended types (RGN2–4 sections) when present. Geometry is delta-decoded with per-subdivision bit widths.
- `lbl.py`: label decoding (6-, 8- and 10-bit encodings). The codepage comes from the LBL header and SRT; Icelandic characters must survive.
- `typ.py`: polygon, line and point definitions (day colours, widths, bitmaps, draw order).
- `features.py`: combines the tiles into GeoJSON features with `layer` (point/line/polygon), `type` (Garmin code incl. subtype), `name`, `minzoom`, `maxzoom`. Each level's objects are emitted in that level's own zoom band, so coarse levels supply generalized geometry at low zoom, as on a Garmin device. The vector pipeline and style use MapLibre zoom (raster zoom − 1). A level with `bits` starts at `bits − 11`, the coarsest level with data starts at z4, and the finest level runs to z14. Raster output is therefore z5–z15.
- `stylegen.py`: builds a MapLibre style from the TYP. It falls back to standard Garmin default styling for type codes the TYP does not define, and adds the hillshade raster layer beneath the vector layers.
- `cli.py`: commands `inspect`, `decode`, `style`, `tile`, `hillshade`, `convert`.

NET/NOD (routing) and MDR/MD2 (search) are ignored.

### Renderer (`render/`)

A Node script that loads `style.json` with sources pointing at the local vector and hillshade MBTiles. It renders every tile in the z5–z15 range that intersects land, using a pool of workers (one per core), and writes PNG tiles (JPEG optional, to save space) into an MBTiles file. It is resumable: tiles already present are skipped.

## Error handling

- The first implementation step inspects the TRE and RGN headers of every tile. **If a tile is encrypted or uses an unsupported format, the converter stops with a message naming the subfile and the reason.** It never produces a silently empty map.
- Decode errors inside a subdivision are logged with the tile and subdivision ID and counted. The run fails if more than 1% of subdivisions fail.
- Coordinates outside Iceland's bounding box (with a margin) are counted as errors.

## Testing and verification

- Unit tests (pytest) cover the bit reader, delta decoding, label encodings and TYP colour/bitmap parsing, using small hand-made byte fixtures.
- Golden checks on the real files: all coordinates fall within the bounding box, feature counts are non-zero per tile and level, and known names decode correctly (Reykjavík, Þórsmörk, Landmannalaugar).
- Visual check: sample tiles (Reykjavík z15, Landmannalaugar z13, whole-country z7) are rendered and compared with QMapShack showing the same IMG. The user reviews these before the full render.
- Full render: ~1.4M tiles (z5–z15 over the Iceland bounds) as ~22k 8×8 metatiles, estimated one to a few hours on 12 cores.

## Out of scope (phase 1)

The iOS/macOS app, routing, address/POI search, and track recording (the viewer app provides that).

## Dependencies

Python 3.13 (+ pytest), Homebrew `tippecanoe` and `gdal`, Node 24 with `@maplibre/maplibre-native` and `better-sqlite3`.
