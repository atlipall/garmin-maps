"""TYP style file parser (port of the relevant parts of QMapShack's CGarminTyp)."""
from dataclasses import dataclass, field

from PIL import Image

from .binary import u32
from .errors import ImgError


@dataclass
class PolygonStyle:
    color: str
    pattern: Image.Image | None = None


@dataclass
class LineStyle:
    color: str
    width: float
    border_color: str | None = None
    border_width: float = 0
    dash: list | None = None


@dataclass
class PointStyle:
    image: Image.Image


@dataclass
class Typ:
    polygons: dict = field(default_factory=dict)
    lines: dict = field(default_factory=dict)
    points: dict = field(default_factory=dict)
    draw_level: dict = field(default_factory=dict)


def empty_typ():
    return Typ()


class _Reader:
    def __init__(self, data, pos=0):
        self.d = data
        self.pos = pos

    def u8(self):
        v = self.d[self.pos]
        self.pos += 1
        return v

    def u16(self):
        v = self.d[self.pos] | (self.d[self.pos + 1] << 8)
        self.pos += 2
        return v

    def u32(self):
        v = u32(self.d, self.pos)
        self.pos += 4
        return v

    def rgb(self):
        b, g, r = self.d[self.pos:self.pos + 3]
        self.pos += 3
        return (r, g, b, 255)


def _hex(rgba):
    return "#{:02x}{:02x}{:02x}".format(*rgba[:3])


def _indices(r, w, h, bpp):
    rows = []
    per_byte = 8 // bpp
    mask = (1 << bpp) - 1
    for _ in range(h):
        row = []
        while len(row) < w:
            byte = r.u8()
            for i in range(per_byte):
                if len(row) >= w:
                    break
                row.append((byte >> (i * bpp)) & mask)
        rows.append(row)
    return rows


def _image(rows, palette):
    img = Image.new("RGBA", (len(rows[0]), len(rows)), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(rows):
        for x, idx in enumerate(row):
            colour = palette[idx] if idx < len(palette) else None
            px[x, y] = colour if colour else (0, 0, 0, 0)
    return img


def _dash(rows):
    cols = [any(row[x] == 1 for row in rows) for x in range(len(rows[0]))]
    if all(cols) or not any(cols):
        return None
    start = next(i for i in range(len(cols)) if cols[i] and not cols[i - 1])
    seq = cols[start:] + cols[:start]
    runs = []
    for on in seq:
        if runs and runs[-1][0] == on:
            runs[-1][1] += 1
        else:
            runs.append([on, 1])
    return [float(n) / len(rows) for _, n in runs]


def _elements(data, array, data_offset):
    off, mod, size = array
    if not mod or not size or size % mod:
        return
    r = _Reader(data)
    for i in range(size // mod):
        r.pos = off + i * mod
        t16 = r.u16()
        if mod == 5:
            o = r.u16() | (r.u8() << 16)
        elif mod == 4:
            o = r.u16()
        elif mod == 3:
            o = r.u8()
        else:
            return
        yield t16, _Reader(data, data_offset + o)


def _line_polygon_type(t16):
    typ = ((t16 >> 5) | ((t16 & 0x1F) << 11)) & 0x7F
    return 0x10000 | (typ << 8) | (t16 & 0x1F) if t16 & 0x2000 else typ


def _point_type(t16):
    typ = ((t16 >> 5) | ((t16 & 0x1F) << 11)) & 0x7FF
    return 0x10000 | (typ << 8) | (t16 & 0x1F) if t16 & 0x2000 else (typ << 8) + (t16 & 0x1F)


def _polygon(r):
    ctyp = r.u8() & 0x0F
    if ctyp in (0x01, 0x06, 0x07):
        return PolygonStyle(_hex(r.rgb()))
    if ctyp in (0x08, 0x09, 0x0D):
        fg, bg = r.rgb(), r.rgb()
        if ctyp == 0x09:
            r.rgb(), r.rgb()
        elif ctyp == 0x0D:
            r.rgb()
        return PolygonStyle(_hex(fg), _image(_indices(r, 32, 32, 1), [bg, fg]))
    if ctyp in (0x0B, 0x0E, 0x0F):
        fg = r.rgb()
        if ctyp == 0x0B:
            r.rgb(), r.rgb()
        elif ctyp == 0x0F:
            r.rgb()
        return PolygonStyle(_hex(fg), _image(_indices(r, 32, 32, 1), [None, fg]))
    return None


_LINE_COLOURS = {0x00: 2, 0x01: 4, 0x03: 3, 0x05: 3, 0x06: 1, 0x07: 2}


def _line(r):
    f1 = r.u8()
    r.u8()
    ctyp, rows = f1 & 0x07, f1 >> 3
    ncolours = _LINE_COLOURS.get(ctyp)
    if ncolours is None:
        return None
    colours = [r.rgb() for _ in range(ncolours)]
    day = _hex(colours[0])
    if rows:
        return LineStyle(day, rows, dash=_dash(_indices(r, 32, rows, 1)))
    if ctyp in (0x00, 0x01, 0x03):
        w1, w2 = r.u8(), r.u8()
    else:
        w1, w2 = r.u8(), 0
    if ctyp in (0x00, 0x01) and w2 > w1:
        return LineStyle(day, w1, _hex(colours[1]), w2)
    return LineStyle(day, w1)


def _bpp(ncolors, flags):
    if flags == 0x00:
        table = [(3, ncolors), (4, 2), (16, 4), (256, 8)]
    elif flags == 0x10:
        if ncolors == 0:
            return 1
        table = [(3, 2), (15, 4), (256, 8)]
    elif flags == 0x20:
        if ncolors == 0:
            return 16
        table = [(3, ncolors), (4, 2), (16, 4), (256, 8)]
    else:
        return None
    for limit, bpp in table:
        if ncolors < limit:
            return bpp
    return None


def _colour_table(r, n, alpha):
    if not alpha:
        return [r.rgb() for _ in range(n)]
    out, reg, bits = [], 0, 0
    for _ in range(n):
        while bits < 28:
            reg = (reg & ~(0xFF << bits)) | (r.u8() << bits)
            bits += 8
        a = round((15 - ((reg >> 24) & 0x0F)) * 255 / 15)
        out.append(((reg >> 16) & 0xFF, (reg >> 8) & 0xFF, reg & 0xFF, a))
        reg >>= 28
        bits -= 28
    return out


def _point(r):
    r.u8()
    w, h, ncolors, flags = r.u8(), r.u8(), r.u8(), r.u8()
    bpp = _bpp(ncolors, flags)
    if not bpp or bpp >= 16 or not w or not h:
        return None
    palette = _colour_table(r, ncolors, flags == 0x20)
    return PointStyle(_image(_indices(r, w, h, bpp), palette))


def _draw_levels(data, array):
    off, mod, size = array
    levels = {}
    if mod != 5 or not size or size % 5:
        return levels
    level = 1
    for i in range(size // 5):
        typ = data[off + i * 5]
        mask = u32(data, off + i * 5 + 1)
        if typ == 0:
            level += 1
        elif mask == 0:
            levels[typ] = level
        else:
            for n in range(32):
                if mask & (1 << n):
                    levels[0x10000 | (typ << 8) | n] = level
    return levels


def parse_typ(data):
    if data[2:12] != b"GARMIN TYP":
        raise ImgError("TYP: bad signature")
    r = _Reader(data, 0x17)
    points_data = (r.u32(), r.u32())
    lines_data = (r.u32(), r.u32())
    polygons_data = (r.u32(), r.u32())
    r.u16(), r.u16()  # product id, family id
    arrays = [(r.u32(), r.u16(), r.u32()) for _ in range(4)]
    typ = Typ(draw_level=_draw_levels(data, arrays[3]))
    for t16, er in _elements(data, arrays[0], points_data[0]):
        style = _point(er)
        if style:
            typ.points[_point_type(t16)] = style
    for t16, er in _elements(data, arrays[1], lines_data[0]):
        style = _line(er)
        if style:
            typ.lines[_line_polygon_type(t16)] = style
    for t16, er in _elements(data, arrays[2], polygons_data[0]):
        style = _polygon(er)
        if style:
            typ.polygons[_line_polygon_type(t16)] = style
    return typ
