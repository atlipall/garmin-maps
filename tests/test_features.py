from imgconv.features import contour_label, in_bounds, to_feature, zoom_bands
from imgconv.rgn import RawObject

U = 2**24 / 360  # map units per degree


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
