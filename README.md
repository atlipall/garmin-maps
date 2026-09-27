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
