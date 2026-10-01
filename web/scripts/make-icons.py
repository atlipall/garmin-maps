"""Generate the app icons (run with the repo's .venv: ../.venv/bin/python scripts/make-icons.py)."""
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "public" / "icons"
out.mkdir(parents=True, exist_ok=True)
def draw(size: int, scale: float, name: str) -> None:
    """The mountains on blue, drawn at `scale` of the icon about its centre (a maskable icon keeps
    its artwork inside the middle 80 %, which Android may crop to a circle)."""
    s = size
    img = Image.new("RGBA", (s, s), "#2c5a85")
    d = ImageDraw.Draw(img)
    p = lambda x, y: (s * (0.5 + (x - 0.5) * scale), s * (0.54 + (y - 0.54) * scale))
    d.polygon([p(0.10, 0.80), p(0.42, 0.28), p(0.58, 0.54), p(0.69, 0.40), p(0.92, 0.80)], fill="#f4f0e4")
    d.polygon([p(0.35, 0.40), p(0.42, 0.28), p(0.49, 0.40)], fill="#ffffff")
    img.save(out / name)
    print("wrote", out / name)


for size in (192, 512):
    draw(size, 1.0, f"icon-{size}.png")
draw(512, 0.72, "icon-512-maskable.png")
