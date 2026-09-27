import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .container import ImgContainer
from .errors import ImgError
from .features import decode_img
from .hillshade import build_dem_mbtiles
from .lbl import LabelTable
from .stylegen import write_style
from .tiling import build_vector_tiles
from .tre import parse_tre
from .typ import empty_typ, parse_typ

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "out"
FONTS = REPO / "assets" / "fonts"
HGT_DIR = REPO / "GPSmap.is 2024.21 Android" / "HILLSHADE - Add content to DEM folder"
RENDERER = REPO / "render" / "render.mjs"


def slug(path):
    return re.sub(r"[^a-z0-9]+", "-", Path(path).stem.lower()).strip("-")


def variant_dir(img):
    return OUT / slug(img)


def cmd_inspect(args):
    img = ImgContainer.from_path(args.img)
    for name in sorted(img.subfiles):
        print(f"{name:16} {len(img.subfiles[name]):>10}")
    for tid in img.tile_ids():
        tre = parse_tre(img.get(f"{tid}.TRE"), img.get(f"{tid}.RGN"))
        LabelTable(img.get(f"{tid}.LBL"), img.get(f"{tid}.NET"))
        with_ext = sum(1 for sd in tre.subdivisions if any(e > s for s, e in sd.ext))
        print(f"tile {tid}: N{tre.north:.3f} S{tre.south:.3f} W{tre.west:.3f} E{tre.east:.3f} "
              f"levels={[lv.bits for lv in tre.levels]} subdivisions={len(tre.subdivisions)} "
              f"with-ext={with_ext}")


def cmd_decode(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    stats = decode_img(Path(args.img), out, args.workers)
    print(f"decoded {stats.features} features into {out / 'features.geojsonseq'}")


def cmd_style(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    types_path = out / "types.json"
    if not types_path.exists():
        raise ImgError(f"{types_path} missing; run `imgconv decode` first")
    typ_bytes = ImgContainer.from_path(args.img).first_of_type("TYP")
    typ = parse_typ(typ_bytes) if typ_bytes else empty_typ()
    write_style(out, typ, json.loads(types_path.read_text()))
    print(f"wrote {out / 'style.json'} and sprite")


def cmd_tiles(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    build_vector_tiles(out / "features.geojsonseq", out / "vector.mbtiles")
    print(f"wrote {out / 'vector.mbtiles'}")


def cmd_dem(args):
    out = Path(args.out)
    build_dem_mbtiles(Path(args.hgt), out, out.parent / "dem-work")


def render_args(out_dir):
    return ["--style", out_dir / "style.json", "--vector", out_dir / "vector.mbtiles",
            "--dem", OUT / "dem.mbtiles", "--sprite", out_dir, "--fonts", FONTS]


def cmd_sample(args):
    out = variant_dir(args.img)
    (out / "samples").mkdir(exist_ok=True)
    target = out / "samples" / f"{args.name or f'z{args.zoom}'}.png"
    # "=" form: node's parseArgs rejects option values that start with "-" (western longitudes)
    subprocess.run(["node", RENDERER, "sample", *render_args(out), f"--center={args.center}",
                    "--zoom", str(args.zoom), "--size", str(args.size), "--out", target], check=True)


def build_parser():
    p = argparse.ArgumentParser(prog="imgconv", description="Garmin IMG to MBTiles converter")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("inspect", help="print IMG structure and fail on unsupported tiles")
    s.add_argument("img")
    s.set_defaults(func=cmd_inspect)
    s = sub.add_parser("decode", help="IMG -> features.geojsonseq + types.json")
    s.add_argument("img")
    s.add_argument("--out")
    s.add_argument("--workers", type=int, default=os.cpu_count())
    s.set_defaults(func=cmd_decode)
    s = sub.add_parser("style", help="TYP -> style.json + sprite")
    s.add_argument("img")
    s.add_argument("--out")
    s.set_defaults(func=cmd_style)
    s = sub.add_parser("tiles", help="features.geojsonseq -> vector.mbtiles (tippecanoe)")
    s.add_argument("img")
    s.add_argument("--out")
    s.set_defaults(func=cmd_tiles)
    s = sub.add_parser("dem", help=".hgt -> terrain-RGB dem.mbtiles (numpy)")
    s.add_argument("--hgt", default=str(HGT_DIR))
    s.add_argument("--out", default=str(OUT / "dem.mbtiles"))
    s.set_defaults(func=cmd_dem)
    s = sub.add_parser("sample", help="render one image for visual checking")
    s.add_argument("img")
    s.add_argument("--center", required=True, help="lon,lat")
    s.add_argument("--zoom", type=int, required=True, help="raster zoom (5-15)")
    s.add_argument("--size", type=int, default=1024)
    s.add_argument("--name")
    s.set_defaults(func=cmd_sample)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ImgError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
