"""Generate the app icons (run with the repo's .venv: ../.venv/bin/python scripts/make-icons.py)."""
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "public" / "icons"
out.mkdir(parents=True, exist_ok=True)
for size in (192, 512):
    s = size
    img = Image.new("RGBA", (s, s), "#2c5a85")
    d = ImageDraw.Draw(img)
    d.polygon([(0.10 * s, 0.80 * s), (0.42 * s, 0.28 * s), (0.58 * s, 0.54 * s), (0.69 * s, 0.40 * s), (0.92 * s, 0.80 * s)], fill="#f4f0e4")
    d.polygon([(0.35 * s, 0.40 * s), (0.42 * s, 0.28 * s), (0.49 * s, 0.40 * s)], fill="#ffffff")
    img.save(out / f"icon-{size}.png")
    print("wrote", out / f"icon-{size}.png")
