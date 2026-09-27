import struct

import pytest

from imgconv.typ import parse_typ


def make_typ(points=(), lines=(), polygons=(), order=()):
    """Each of points/lines/polygons: list of (t16, element_bytes). order: list of (type, subtype_mask)."""
    hdr = bytearray(0x5B)
    struct.pack_into("<H", hdr, 0, 0x5B)
    hdr[2:12] = b"GARMIN TYP"
    struct.pack_into("<H", hdr, 0x15, 1252)
    body = bytearray()
    sections = []
    for elements in (points, lines, polygons):
        data_start = len(body)
        index = []
        for t16, data in elements:
            index.append((t16, len(body) - data_start))  # offsets are relative to the section start
            body += data
        sections.append((0x5B + data_start, len(body) - data_start, index))
    arrays = []
    for _, _, index in sections:
        array_start = len(body)
        for t16, off in index:
            body += struct.pack("<HH", t16, off)
        arrays.append((0x5B + array_start, 4, 4 * len(index)))
    array_start = len(body)
    for typ, mask in order:
        body += struct.pack("<BI", typ, mask)
    arrays.append((0x5B + array_start, 5, 5 * len(order)))
    for (off, length, _), at in zip(sections, (0x17, 0x1F, 0x27)):
        struct.pack_into("<II", hdr, at, off, length)
    for (off, mod, size), at in zip(arrays, (0x33, 0x3D, 0x47, 0x51)):
        struct.pack_into("<IHI", hdr, at, off, mod, size)
    return bytes(hdr) + bytes(body)


def test_polygon_solid_colour_and_draw_order():
    typ = parse_typ(make_typ(polygons=[(0x50 << 5, bytes([0x06, 0x30, 0x20, 0x10]))],
                             order=[(0x50, 0), (0, 0), (0x3C, 0)]))
    assert typ.polygons[0x50].color == "#102030"
    assert typ.polygons[0x50].pattern is None
    assert typ.draw_level == {0x50: 1, 0x3C: 2}


def test_polygon_pattern():
    data = bytes([0x08]) + bytes([0, 0, 255]) + bytes([255, 255, 255]) + bytes([0xFF] * 128)
    typ = parse_typ(make_typ(polygons=[(0x4E << 5, data)]))
    style = typ.polygons[0x4E]
    assert style.color == "#ff0000"
    assert style.pattern.size == (32, 32)
    assert style.pattern.getpixel((5, 5)) == (255, 0, 0, 255)


def test_line_with_border():
    data = bytes([0x00, 0x00]) + bytes([0, 0, 255]) + bytes([0, 0, 0]) + bytes([3, 5])
    line = parse_typ(make_typ(lines=[(0x16 << 5, data)])).lines[0x16]
    assert (line.color, line.width, line.border_color, line.border_width, line.dash) == ("#ff0000", 3, "#000000", 5, None)


def test_bitmap_line_becomes_dash():
    data = bytes([(1 << 3) | 0x06, 0x00]) + bytes([0, 0, 255]) + bytes([0xFF, 0x00, 0xFF, 0x00])
    line = parse_typ(make_typ(lines=[(0x0A << 5, data)])).lines[0x0A]
    assert (line.color, line.width, line.dash) == ("#ff0000", 1, [8.0, 8.0, 8.0, 8.0])


def test_point_bitmap_with_subtype():
    data = bytes([0x01, 4, 1, 1, 0x00]) + bytes([0x00, 0xFF, 0x00]) + bytes([0b1010])
    typ = parse_typ(make_typ(points=[((0x2F << 5) | 6, data)]))
    img = typ.points[0x2F06].image
    assert img.size == (4, 1)
    assert img.getpixel((0, 0)) == (0, 255, 0, 255)
    assert img.getpixel((1, 0))[3] == 0


@pytest.mark.realdata
def test_real_typ(detailed_img):
    typ = parse_typ(detailed_img.first_of_type("TYP"))
    assert len(typ.polygons) >= 32
    assert len(typ.lines) >= 26
    assert len(typ.points) >= 12
    assert typ.draw_level
