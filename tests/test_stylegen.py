from PIL import Image

from imgconv.stylegen import build_style, pack_sprite
from imgconv.typ import LineStyle, PointStyle, PolygonStyle, Typ


def ids(style):
    return [layer["id"] for layer in style["layers"]]


def test_layer_order_and_sources():
    typ = Typ(polygons={0x3C: PolygonStyle("#0000ff"), 0x50: PolygonStyle("#00ff00")},
              lines={0x16: LineStyle("#ff0000", 3, "#000000", 5)},
              draw_level={0x50: 1, 0x3C: 2})
    types = {"polygons": {str(0x3C): 5, str(0x50): 9}, "lines": {str(0x16): 2, str(0x20): 1}, "points": {}}
    style, images = build_style(typ, types)
    order = ids(style)
    assert order[0] == "background"
    assert order.index("pg-80") < order.index("pg-60") < order.index("hillshade")
    # all casings go below all line fills; contours (32) sort below trails (22)
    assert order.index("hillshade") < order.index("ln-22-casing") < order.index("ln-32") < order.index("ln-22")
    assert style["sources"]["garmin"]["tiles"] == ["mbtiles://vector/{z}/{x}/{y}"]
    assert style["sources"]["dem"]["type"] == "raster-dem"
    assert style["glyphs"] == "fonts://{fontstack}/{range}.pbf"
    pg = next(layer for layer in style["layers"] if layer["id"] == "pg-60")
    assert pg["filter"] == ["==", ["get", "t"], 0x3C]
    assert pg["paint"]["fill-color"] == "#0000ff"


def test_pattern_and_icons_go_to_sprite():
    pattern = Image.new("RGBA", (32, 32), (1, 2, 3, 255))
    icon = Image.new("RGBA", (8, 8), (9, 9, 9, 255))
    typ = Typ(polygons={0x4E: PolygonStyle("#010203", pattern)}, points={0x2F06: PointStyle(icon)})
    types = {"polygons": {str(0x4E): 1}, "lines": {}, "points": {str(0x2F06): 3, str(0x6400): 1}}
    style, images = build_style(typ, types)
    assert set(images) == {"pg-78", "pt-12038"}
    pg = next(layer for layer in style["layers"] if layer["id"] == "pg-78")
    assert pg["paint"]["fill-pattern"] == "pg-78"
    icons = next(layer for layer in style["layers"] if layer["id"] == "poi-icons")
    assert icons["filter"] == ["in", ["get", "t"], ["literal", [0x2F06]]]


def test_unknown_types_fall_back_or_skip():
    types = {"polygons": {str(0x4A): 1, str(0x50): 1}, "lines": {str(0x01): 1}, "points": {}}
    style, _ = build_style(Typ(), types)
    assert "pg-74" not in ids(style)
    assert "pg-80" in ids(style)
    assert "ln-1" in ids(style)


def test_pack_sprite():
    images = {"a": Image.new("RGBA", (10, 20)), "b": Image.new("RGBA", (30, 5))}
    sheet, index = pack_sprite(images)
    assert index["a"] == {"x": 0, "y": 0, "width": 10, "height": 20, "pixelRatio": 1}
    assert index["b"]["x"] == 11
    assert sheet.size[1] >= 20
