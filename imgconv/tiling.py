import subprocess

from .features import MAX_ZOOM, MIN_ZOOM


def build_vector_tiles(features, out):
    subprocess.run([
        "tippecanoe", "-o", str(out), "--force", "-n", "GPSmap.is",
        f"-Z{MIN_ZOOM}", f"-z{MAX_ZOOM}", "-d", "13",
        "--no-feature-limit", "--no-tile-size-limit", "--no-tiny-polygon-reduction",
        "--read-parallel", "--quiet", str(features),
    ], check=True)
