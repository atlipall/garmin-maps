import struct

import pytest

from imgconv.errors import ImgError
from imgconv.features import check_thresholds, contour_label, decode_img, decode_tile, in_bounds, to_feature, \
    zoom_bands
from imgconv.rgn import DecodeStats, RawObject
from tests.builders import build_img, make_rgn_header, make_tre

U = 2**24 / 360  # map units per degree


def _make_lbl():
    """A minimal but valid LBL subfile with no label strings."""
    hlen = 0xAC
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN LBL"
    h[0x1E] = 9
    struct.pack_into("<II", h, 0x15, hlen, 1)
    struct.pack_into("<II", h, 0x57, hlen + 1, 0)
    struct.pack_into("<H", h, 0xAA, 1252)
    return bytes(h) + b"\0"


def test_zoom_bands_start_coarsest_at_4():
    assert zoom_bands([18, 20, 22, 24]) == {18: (4, 8), 20: (9, 10), 22: (11, 12), 24: (13, 14)}


def test_zoom_bands_single_level():
    assert zoom_bands([24]) == {24: (4, 14)}


def test_polygon_is_closed():
    obj = RawObject("polygon", 0x3C, 0, "lbl", [(0, 0), (int(U), 0), (int(U), int(U))])
    f = to_feature(obj, "Vatn", (9, 10))
    ring = f["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 4
    assert f["tippecanoe"] == {"layer": "polygons", "minzoom": 9, "maxzoom": 10}
    assert f["properties"] == {"t": 0x3C, "name": "Vatn"}


def test_degenerate_geometry_dropped():
    assert to_feature(RawObject("line", 1, 0, "lbl", [(0, 0)]), None, (4, 14)) is None
    assert to_feature(RawObject("polygon", 1, 0, "lbl", [(0, 0), (1, 1)]), None, (4, 14)) is None


def test_point_feature():
    f = to_feature(RawObject("point", 0x2F06, 0, "lbl", [(int(-20 * U), int(64 * U))]), None, (13, 14))
    assert f["geometry"]["type"] == "Point"
    assert f["geometry"]["coordinates"] == [round(int(-20 * U) / U, 6), round(int(64 * U) / U, 6)]
    assert "name" not in f["properties"]


def test_contour_label_feet_to_metres():
    assert contour_label("328") == "100"
    assert contour_label("Hekla") == "Hekla"


def test_in_bounds():
    assert in_bounds({"type": "Point", "coordinates": [-20.0, 64.0]})
    assert not in_bounds({"type": "Point", "coordinates": [10.0, 64.0]})


def test_check_thresholds_raises_on_bad_section_rate():
    stats = DecodeStats(sections=100, bad_sections=2, features=10, out_of_bounds=0)
    with pytest.raises(ImgError, match="RGN sections failed to decode"):
        check_thresholds(stats)


def test_check_thresholds_raises_on_out_of_bounds_rate():
    stats = DecodeStats(sections=10, bad_sections=0, features=98, out_of_bounds=2)
    with pytest.raises(ImgError, match="fell outside Iceland"):
        check_thresholds(stats)


def test_check_thresholds_raises_on_zero_features():
    stats = DecodeStats(sections=5, bad_sections=0, features=0, out_of_bounds=0)
    with pytest.raises(ImgError, match="no features decoded"):
        check_thresholds(stats)


def test_check_thresholds_passes_within_limits():
    stats = DecodeStats(sections=100, bad_sections=1, features=100, out_of_bounds=1)
    check_thresholds(stats)  # must not raise


def test_decode_tile_missing_rgn_raises_named_error(tmp_path):
    """A synthetic IMG with a TRE but no RGN subfile must raise ImgError naming the tile."""
    files = {"00000001.TRE": make_tre([], [])}
    img_path = tmp_path / "test.img"
    img_path.write_bytes(build_img(files))
    with pytest.raises(ImgError, match="00000001: missing RGN subfile"):
        decode_tile(img_path, "00000001", tmp_path / "out.geojsonseq")


def test_decode_img_raises_on_no_tiles(tmp_path):
    files = {"AAAAAAAA.TYP": b"x" * 10}
    img_path = tmp_path / "test.img"
    img_path.write_bytes(build_img(files))
    with pytest.raises(ImgError, match="no map tiles"):
        decode_img(img_path, tmp_path / "out")


def test_decode_img_removes_geojson_and_types_but_keeps_stats_on_threshold_failure(tmp_path):
    files = {
        "00000001.TRE": make_tre([], []),
        "00000001.RGN": make_rgn_header(0),
        "00000001.LBL": _make_lbl(),
    }
    img_path = tmp_path / "test.img"
    img_path.write_bytes(build_img(files))
    out_dir = tmp_path / "out"

    with pytest.raises(ImgError, match="no features decoded"):
        decode_img(img_path, out_dir, workers=1)

    assert not (out_dir / "features.geojsonseq").exists()
    assert not (out_dir / "types.json").exists()
    assert (out_dir / "decode-stats.json").exists()


def test_decode_img_cleans_up_part_files_on_worker_error(tmp_path):
    """One tile decodes fine (and gets a real part file); the other has a corrupt TRE and makes
    the worker raise ImgError. decode_img must not leave any part-*.geojsonseq files behind."""
    files = {
        "00000001.TRE": make_tre([], []),
        "00000001.RGN": make_rgn_header(0),
        "00000001.LBL": _make_lbl(),
        "00000002.TRE": b"\x00" * 20,  # fails the "GARMIN TRE" signature check inside the worker
        "00000002.RGN": make_rgn_header(0),
    }
    img_path = tmp_path / "test.img"
    img_path.write_bytes(build_img(files))
    out_dir = tmp_path / "out"

    with pytest.raises(ImgError):
        decode_img(img_path, out_dir, workers=2)

    assert list(out_dir.iterdir()) == []
