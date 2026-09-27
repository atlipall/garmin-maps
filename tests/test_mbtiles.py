import io
import sqlite3

import numpy as np
from PIL import Image

from imgconv.hillshade import build_dem_mbtiles, decode_terrain_rgb
from imgconv.mbtiles import write_from_xyz


def test_write_from_xyz_flips_rows(tmp_path):
    (tmp_path / "xyz" / "3" / "2").mkdir(parents=True)
    (tmp_path / "xyz" / "3" / "2" / "1.png").write_bytes(b"PNG")
    out = tmp_path / "t.mbtiles"
    assert write_from_xyz(tmp_path / "xyz", out, {"name": "t", "format": "png"}) == 1
    db = sqlite3.connect(out)
    assert db.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles").fetchall() == [(3, 2, 6, b"PNG")]
    assert dict(db.execute("SELECT name, value FROM metadata")) == {"name": "t", "format": "png"}


def test_decode_terrain_rgb():
    assert decode_terrain_rgb(1, 134, 160) == 0.0
    assert round(decode_terrain_rgb(1, 217, 32), 1) == 2112.0


def test_build_dem_mbtiles_from_synthetic_hgt(tmp_path):
    hgt_dir = tmp_path / "hgt"
    hgt_dir.mkdir()
    height = 1000
    np.full((1201, 1201), height, dtype=">i2").tofile(hgt_dir / "n63w014.hgt")
    out = tmp_path / "dem.mbtiles"
    build_dem_mbtiles(hgt_dir, out, tmp_path / "work", maxzoom=6)

    db = sqlite3.connect(out)
    rows = db.execute("SELECT tile_data FROM tiles").fetchall()
    assert len(rows) > 0

    top = 0.0
    for (data,) in rows:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        top = max(top, max(decode_terrain_rgb(r, g, b) for r, g, b in img.getdata()))
    assert abs(top - height) <= 1
