import io
import math

import numpy as np
from PIL import Image

from .errors import ImgError
from .mbtiles import create

TILE_SIZE = 256
HGT_SIZE = 1201
HGT_STEP = HGT_SIZE - 1  # 1200 samples per degree of a SRTM3 tile


def decode_terrain_rgb(r, g, b):
    return -10000 + (r * 65536 + g * 256 + b) * 0.1


def _encode_terrain_rgb(height):
    v = np.round((np.clip(height, 0, None) + 10000) * 10).astype(np.int64)
    r = (v // 65536) % 256
    g = (v // 256) % 256
    b = v % 256
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def _parse_hgt_name(path):
    name = path.stem.lower()
    lat = int(name[1:3]) * (1 if name[0] == "n" else -1)
    lon = int(name[4:7]) * (1 if name[3] == "e" else -1)
    return lat, lon


def _load_mosaic(hgts):
    """Load SRTM3 .hgt tiles into one array covering their combined bounds.

    Each tile is 1201x1201 big-endian int16 samples; row 0 is the north edge,
    column 0 is the west edge, and adjacent tiles share their common edge.
    """
    tiles = {}
    for path in hgts:
        south, west = _parse_hgt_name(path)
        arr = np.fromfile(path, dtype=">i2")
        if arr.size != HGT_SIZE * HGT_SIZE:
            raise ImgError(f"{path} is not a valid SRTM3 (1201x1201) .hgt tile")
        arr = np.clip(arr.reshape(HGT_SIZE, HGT_SIZE), 0, None)  # voids and negatives -> 0
        tiles[(south, west)] = arr

    souths = [s for s, _ in tiles]
    wests = [w for _, w in tiles]
    south_min, south_max = min(souths), max(souths)
    west_min, west_max = min(wests), max(wests)
    rows = (south_max - south_min + 1) * HGT_STEP + 1
    cols = (west_max - west_min + 1) * HGT_STEP + 1
    mosaic = np.zeros((rows, cols), dtype=np.int16)
    for (south, west), arr in tiles.items():
        row0 = (south_max - south) * HGT_STEP
        col0 = (west - west_min) * HGT_STEP
        mosaic[row0:row0 + HGT_SIZE, col0:col0 + HGT_SIZE] = arr
    bounds = (west_min, south_min, west_max + 1, south_max + 1)  # west, south, east, north
    return mosaic, bounds


def _sample(mosaic, bounds, lon, lat):
    west, south, east, north = bounds
    rows, cols = mosaic.shape
    outside = (lat < south) | (lat > north) | (lon < west) | (lon > east)
    row = np.clip((north - lat) * HGT_STEP, 0, rows - 1)
    col = np.clip((lon - west) * HGT_STEP, 0, cols - 1)
    r0 = np.floor(row).astype(np.int64)
    c0 = np.floor(col).astype(np.int64)
    r1 = np.minimum(r0 + 1, rows - 1)
    c1 = np.minimum(c0 + 1, cols - 1)
    fr = row - r0
    fc = col - c0
    top = mosaic[r0, c0] * (1 - fc) + mosaic[r0, c1] * fc
    bottom = mosaic[r1, c0] * (1 - fc) + mosaic[r1, c1] * fc
    height = top * (1 - fr) + bottom * fr
    return np.where(outside, 0.0, height)


def _tile2lon(x, z):
    return x / 2 ** z * 360.0 - 180.0


def _tile2lat(y, z):
    n = math.pi - 2 * math.pi * y / 2 ** z
    return np.degrees(np.arctan(np.sinh(n)))


def _deg2tile(lon, lat, z):
    lat_rad = math.radians(lat)
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def _tiles_for_zoom(bounds, z):
    west, south, east, north = bounds
    n = 2 ** z
    x0, y0 = _deg2tile(west, min(north, 85.0), z)
    x1, y1 = _deg2tile(east, max(south, -85.0), z)
    x_min = max(0, min(int(math.floor(x0)), n - 1))
    x_max = max(0, min(int(math.floor(x1)), n - 1))
    y_min = max(0, min(int(math.floor(y0)), n - 1))
    y_max = max(0, min(int(math.floor(y1)), n - 1))
    for x in range(x_min, x_max + 1):
        for y in range(y_min, y_max + 1):
            yield x, y


def _render_tile(mosaic, bounds, x, y, z):
    px = np.arange(TILE_SIZE)
    lons = _tile2lon(x + (px + 0.5) / TILE_SIZE, z)
    lats = _tile2lat(y + (px + 0.5) / TILE_SIZE, z)
    lon_grid = np.broadcast_to(lons[None, :], (TILE_SIZE, TILE_SIZE))
    lat_grid = np.broadcast_to(lats[:, None], (TILE_SIZE, TILE_SIZE))
    heights = _sample(mosaic, bounds, lon_grid, lat_grid)
    rgb = _encode_terrain_rgb(heights)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG")
    return buf.getvalue()


def build_dem_mbtiles(hgt_dir, out, work, maxzoom=11):
    hgts = sorted(hgt_dir.glob("*.hgt"))
    if not hgts:
        raise ImgError(f"no .hgt files in {hgt_dir}")
    mosaic, bounds = _load_mosaic(hgts)
    db = create(out, {"name": "dem", "format": "png", "type": "overlay",
                       "minzoom": "5", "maxzoom": str(maxzoom), "encoding": "mapbox"})
    count = 0
    for z in range(5, maxzoom + 1):
        for x, y in _tiles_for_zoom(bounds, z):
            png = _render_tile(mosaic, bounds, x, y, z)
            tms_row = (1 << z) - 1 - y
            db.execute("INSERT INTO tiles VALUES (?, ?, ?, ?)", (z, x, tms_row, png))
            count += 1
    db.commit()
    db.close()
    print(f"wrote {count} DEM tiles to {out}")
