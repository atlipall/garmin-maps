import json

from PIL import Image

from .fallback_styles import (BACKGROUND, DEFAULT_LINE, DEFAULT_LINE_PRIORITY, LINE_PRIORITY, LINE_STYLES,
                              POLYGON_COLORS, SKIP_POLYGONS)
from .features import CONTOUR_LINE_TYPES, MAX_ZOOM, MIN_ZOOM
from .typ import LineStyle

FONT_REGULAR = "Noto Sans Regular"
FONT_ITALIC = "Noto Sans Italic"
HALO = {"text-halo-color": "#ffffff", "text-halo-width": 1.2}
CONTOURS = sorted(CONTOUR_LINE_TYPES)


def _filter(t):
    return ["==", ["get", "t"], t]


def _polygon_layer(t, style, images):
    base = {"id": f"pg-{t}", "type": "fill", "source": "garmin", "source-layer": "polygons", "filter": _filter(t)}
    if style and style.pattern is not None:
        images[f"pg-{t}"] = style.pattern
        return {**base, "paint": {"fill-pattern": f"pg-{t}", "fill-antialias": False}}
    color = style.color if style else (None if t in SKIP_POLYGONS else POLYGON_COLORS.get(t))
    if color is None:
        return None
    return {**base, "paint": {"fill-color": color, "fill-antialias": False}}


def _line_style(t, style):
    if style:
        return style
    color, width, dash = LINE_STYLES.get(t, DEFAULT_LINE)
    return LineStyle(color, width, dash=dash)


def _line_layer(layer_id, t, color, width, dash):
    paint = {"line-color": color,
             "line-width": ["interpolate", ["linear"], ["zoom"], 8, max(0.5, width * 0.4), 14, max(1, width)]}
    if dash:
        paint["line-dasharray"] = dash
    return {"id": layer_id, "type": "line", "source": "garmin", "source-layer": "lines", "filter": _filter(t),
            "layout": {"line-join": "round", "line-cap": "butt" if dash else "round"}, "paint": paint}


def _label_layers():
    is_contour = ["in", ["get", "t"], ["literal", CONTOURS]]
    return [
        {"id": "pg-labels", "type": "symbol", "source": "garmin", "source-layer": "polygons",
         "filter": ["has", "name"],
         "layout": {"text-field": ["get", "name"], "text-font": [FONT_ITALIC], "text-size": 11, "text-max-width": 8},
         "paint": {"text-color": "#2c5a85", **HALO}},
        {"id": "contour-labels", "type": "symbol", "source": "garmin", "source-layer": "lines",
         "filter": ["all", ["has", "name"], is_contour],
         "layout": {"symbol-placement": "line", "text-field": ["get", "name"], "text-font": [FONT_REGULAR],
                    "text-size": 9},
         "paint": {"text-color": "#8a6a4a", **HALO}},
        {"id": "line-labels", "type": "symbol", "source": "garmin", "source-layer": "lines",
         "filter": ["all", ["has", "name"], ["!", is_contour]],
         "layout": {"symbol-placement": "line", "text-field": ["get", "name"], "text-font": [FONT_REGULAR],
                    "text-size": 11, "text-max-angle": 30},
         "paint": {"text-color": "#333333", **HALO}},
    ]


def _point_layers(icon_types):
    has_icon = ["in", ["get", "t"], ["literal", icon_types]]
    text = {"text-font": [FONT_REGULAR], "text-size": 10, "text-anchor": "top", "text-max-width": 8}
    return [
        {"id": "poi-dots", "type": "circle", "source": "garmin", "source-layer": "points",
         "filter": ["!", has_icon],
         "paint": {"circle-radius": 2.5, "circle-color": "#555555", "circle-stroke-color": "#ffffff",
                   "circle-stroke-width": 1}},
        {"id": "poi-dot-labels", "type": "symbol", "source": "garmin", "source-layer": "points",
         "filter": ["all", ["!", has_icon], ["has", "name"]],
         "layout": {"text-field": ["get", "name"], "text-offset": [0, 0.8], **text},
         "paint": {"text-color": "#222222", **HALO}},
        {"id": "poi-icons", "type": "symbol", "source": "garmin", "source-layer": "points", "filter": has_icon,
         "layout": {"icon-image": ["concat", "pt-", ["to-string", ["get", "t"]]],
                    "text-field": ["coalesce", ["get", "name"], ""], "text-offset": [0, 1.1],
                    "text-optional": True, **text},
         "paint": {"text-color": "#222222", **HALO}},
    ]


def build_style(typ, types):
    images = {}
    layers = [{"id": "background", "type": "background", "paint": {"background-color": BACKGROUND}}]
    polygon_types = sorted((int(t) for t in types.get("polygons", {})), key=lambda t: (typ.draw_level.get(t, 0), t))
    for t in polygon_types:
        layer = _polygon_layer(t, typ.polygons.get(t), images)
        if layer:
            layers.append(layer)
    layers.append({"id": "hillshade", "type": "hillshade", "source": "dem",
                   "paint": {"hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#5a4a3a",
                             "hillshade-accent-color": "#5a4a3a", "hillshade-highlight-color": "#ffffff"}})
    line_types = sorted((int(t) for t in types.get("lines", {})),
                        key=lambda t: (LINE_PRIORITY.get(t, DEFAULT_LINE_PRIORITY), t))
    line_styles = {t: _line_style(t, typ.lines.get(t)) for t in line_types}
    for t in line_types:
        s = line_styles[t]
        if s.border_color:
            layers.append(_line_layer(f"ln-{t}-casing", t, s.border_color, s.border_width, None))
    for t in line_types:
        s = line_styles[t]
        layers.append(_line_layer(f"ln-{t}", t, s.color, s.width, s.dash))
    layers += _label_layers()
    icon_types = [t for t in sorted(int(t) for t in types.get("points", {})) if t in typ.points]
    for t in icon_types:
        images[f"pt-{t}"] = typ.points[t].image
    layers += _point_layers(icon_types)
    style = {
        "version": 8,
        "name": "GPSmap.is",
        "sources": {
            "garmin": {"type": "vector", "tiles": ["mbtiles://vector/{z}/{x}/{y}"],
                       "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM},
            "dem": {"type": "raster-dem", "tiles": ["mbtiles://dem/{z}/{x}/{y}"], "tileSize": 256,
                    "minzoom": 5, "maxzoom": 11, "encoding": "mapbox"},
        },
        "glyphs": "fonts://{fontstack}/{range}.pbf",
        "sprite": "sprite://sprite",
        "layers": layers,
    }
    return style, images


def pack_sprite(images):
    width = 512
    x = y = row_h = 0
    index, placed = {}, []
    for name, img in sorted(images.items(), key=lambda kv: (-kv[1].height, kv[0])):
        w, h = img.size
        if x + w > width:
            x, y, row_h = 0, y + row_h + 1, 0
        placed.append((img, x, y))
        index[name] = {"x": x, "y": y, "width": w, "height": h, "pixelRatio": 1}
        x += w + 1
        row_h = max(row_h, h)
    sheet = Image.new("RGBA", (width, max(1, y + row_h)), (0, 0, 0, 0))
    for img, px, py in placed:
        sheet.paste(img, (px, py))
    return sheet, index


def write_style(out_dir, typ, types):
    style, images = build_style(typ, types)
    sheet, index = pack_sprite(images)
    (out_dir / "style.json").write_text(json.dumps(style, indent=1))
    sheet.save(out_dir / "sprite.png")
    (out_dir / "sprite.json").write_text(json.dumps(index, indent=1))
