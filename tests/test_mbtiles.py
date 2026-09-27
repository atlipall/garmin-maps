import io
import sqlite3

import numpy as np
import pytest
from PIL import Image

import imgconv.hillshade as hillshade
from imgconv.hillshade import build_dem_mbtiles, decode_terrain_rgb


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


def test_build_dem_mbtiles_leaves_no_output_if_a_tile_render_raises_midway(tmp_path, monkeypatch):
    hgt_dir = tmp_path / "hgt"
    hgt_dir.mkdir()
    np.full((1201, 1201), 500, dtype=">i2").tofile(hgt_dir / "n63w014.hgt")
    out = tmp_path / "dem.mbtiles"

    real_render_tile = hillshade._render_tile
    calls = {"n": 0}

    def flaky_render_tile(mosaic, bounds, x, y, z):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("boom")
        return real_render_tile(mosaic, bounds, x, y, z)

    monkeypatch.setattr(hillshade, "_render_tile", flaky_render_tile)

    with pytest.raises(RuntimeError, match="boom"):
        build_dem_mbtiles(hgt_dir, out, tmp_path / "work", maxzoom=6)

    assert calls["n"] > 1  # the failure really did happen mid-generation
    assert not out.exists()
    assert not out.with_name(out.name + ".tmp").exists()
