import argparse
import os
import re
import sys
from pathlib import Path

from .container import ImgContainer
from .errors import ImgError
from .features import decode_img
from .lbl import LabelTable
from .tre import parse_tre

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "out"
FONTS = REPO / "assets" / "fonts"
HGT_DIR = REPO / "GPSmap.is 2024.21 Android" / "HILLSHADE - Add content to DEM folder"


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
