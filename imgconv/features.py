import json
import os
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .binary import map_units_to_deg
from .container import ImgContainer
from .errors import ImgError
from .lbl import LabelTable
from .rgn import DecodeStats, decode_subdivision
from .tre import parse_tre

ZOOM_OFFSET = 11
MIN_ZOOM = 4
MAX_ZOOM = 14
MAX_ERROR_RATE = 0.01
CONTOUR_LINE_TYPES = frozenset(range(0x20, 0x26))
LAYERS = {"point": "points", "line": "lines", "polygon": "polygons"}
ICELAND = (-26.5, 62.5, -11.5, 67.5)  # w, s, e, n


def zoom_bands(bits):
    """Map level resolution (bits) to a (minzoom, maxzoom) band in MapLibre zoom."""
    levels = sorted(set(bits))
    starts = [MIN_ZOOM] + [min(MAX_ZOOM, max(MIN_ZOOM, b - ZOOM_OFFSET)) for b in levels[1:]]
    bands = {}
    for i, b in enumerate(levels):
        end = starts[i + 1] - 1 if i + 1 < len(levels) else MAX_ZOOM
        if end >= starts[i]:
            bands[b] = (starts[i], end)
    return bands


def contour_label(name):
    try:
        return str(round(float(name) * 0.3048))
    except ValueError:
        return name


def to_feature(obj, name, band):
    coords = [[round(map_units_to_deg(x), 6), round(map_units_to_deg(y), 6)] for x, y in obj.coords]
    if obj.kind == "point":
        geometry = {"type": "Point", "coordinates": coords[0]}
    elif obj.kind == "line":
        if len(coords) < 2:
            return None
        geometry = {"type": "LineString", "coordinates": coords}
    else:
        if len(coords) < 3:
            return None
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        geometry = {"type": "Polygon", "coordinates": [coords]}
    properties = {"t": obj.type}
    if name:
        properties["name"] = name
    return {"type": "Feature",
            "tippecanoe": {"layer": LAYERS[obj.kind], "minzoom": band[0], "maxzoom": band[1]},
            "properties": properties, "geometry": geometry}


def in_bounds(geometry):
    w, s, e, n = ICELAND
    coords = geometry["coordinates"]
    if geometry["type"] == "Point":
        coords = [coords]
    elif geometry["type"] == "Polygon":
        coords = coords[0]
    return all(w <= x <= e and s <= y <= n for x, y in coords)


def decode_tile(img_path, tile_id, out_path):
    img = ImgContainer.from_path(img_path)
    rgn = img.get(f"{tile_id}.RGN")
    tre = parse_tre(img.get(f"{tile_id}.TRE"), rgn)
    labels = LabelTable(img.get(f"{tile_id}.LBL"), img.get(f"{tile_id}.NET"))
    level_bits = [sd.level.bits for sd in tre.subdivisions if sd.has_data]
    bands = zoom_bands(level_bits)
    missing = set(level_bits) - bands.keys()
    if missing:
        print(f"  tile {tile_id}: warning: levels {sorted(missing)} get no zoom band and are skipped")
    stats = DecodeStats()
    types = {layer: Counter() for layer in LAYERS.values()}
    with open(out_path, "w", encoding="utf-8") as f:
        for sd in tre.subdivisions:
            band = bands.get(sd.level.bits)
            if band is None or not sd.has_data:
                continue
            for obj in decode_subdivision(rgn, sd, stats):
                name = labels.text(obj.label, obj.label_src)
                if name and obj.kind == "line" and obj.type in CONTOUR_LINE_TYPES:
                    name = contour_label(name)
                feature = to_feature(obj, name, band)
                if feature is None:
                    continue
                if not in_bounds(feature["geometry"]):
                    stats.out_of_bounds += 1
                    continue
                f.write(json.dumps(feature, ensure_ascii=False, separators=(",", ":")) + "\n")
                types[LAYERS[obj.kind]][obj.type] += 1
                stats.features += 1
    return tile_id, stats, types


def decode_img(img_path, out_dir, workers=os.cpu_count()):
    img_path, out_dir = Path(img_path), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tile_ids = ImgContainer.from_path(img_path).tile_ids()
    total = DecodeStats()
    types = {layer: Counter() for layer in LAYERS.values()}
    parts = [out_dir / f"part-{tid}.geojsonseq" for tid in tile_ids]
    try:
        with ProcessPoolExecutor(max_workers=min(workers, len(tile_ids))) as pool:
            for tile_id, stats, tile_types in pool.map(decode_tile, [img_path] * len(tile_ids), tile_ids, parts):
                print(f"  tile {tile_id}: {stats.features} features, "
                      f"{stats.bad_sections}/{stats.sections} bad sections, {stats.out_of_bounds} out of bounds")
                total.add(stats)
                for layer, counter in tile_types.items():
                    types[layer].update(counter)
        with open(out_dir / "features.geojsonseq", "wb") as out:
            for part in parts:
                with open(part, "rb") as f:
                    while chunk := f.read(1 << 24):
                        out.write(chunk)
                part.unlink()
    except Exception:
        for part in parts:
            part.unlink(missing_ok=True)
        raise
    (out_dir / "types.json").write_text(json.dumps(
        {layer: {str(t): n for t, n in sorted(c.items())} for layer, c in types.items()}, indent=1))
    (out_dir / "decode-stats.json").write_text(json.dumps(total.__dict__, indent=1))
    if total.sections and total.bad_sections / total.sections > MAX_ERROR_RATE:
        raise ImgError(f"{total.bad_sections} of {total.sections} RGN sections failed to decode")
    if total.features and total.out_of_bounds / total.features > MAX_ERROR_RATE:
        raise ImgError(f"{total.out_of_bounds} features fell outside Iceland")
    return total
