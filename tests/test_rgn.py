import pytest

from imgconv.rgn import DecodeStats, decode_subdivision
from imgconv.tre import EMPTY_EXT, KIND_LINES, KIND_POINTS, Level, Subdivision, parse_tre

LEVEL24 = Level(0, 24, False, 1)


def sub(start, end, kinds, ext=EMPTY_EXT):
    return Subdivision(0, LEVEL24, kinds, 1000, 2000, start, end, ext)


def test_points_and_lines_with_section_pointer():
    point = bytes([0x2F, 0x05, 0x00, 0x80, 0x01, 0x00, 0xFF, 0xFF, 0x06])  # subtype flag, dx=1 dy=-1, subtype 6
    line = bytes([0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x95])
    body = (2 + len(point)).to_bytes(2, "little") + point + line
    rgn = bytes(10) + body
    stats = DecodeStats()
    objs = decode_subdivision(rgn, sub(10, 10 + len(body), KIND_POINTS | KIND_LINES), stats)
    assert [(o.kind, o.type, o.label, o.label_src, o.coords) for o in objs] == [
        ("point", 0x2F06, 5, "lbl", [(1001, 1999)]),
        ("line", 0x16, 0, "lbl", [(1000, 2000), (1001, 2002)]),
    ]
    assert (stats.sections, stats.bad_sections) == (2, 0)


def test_extended_polygon_with_label():
    rec = bytes([0x03, 0x21, 0x02, 0x00, 0x03, 0x00, 0x07, 0x00, 0x25, 0x01, 0x07, 0x00, 0x00])
    rgn = bytes(4) + rec
    stats = DecodeStats()
    objs = decode_subdivision(rgn, sub(0, 0, 0, ext=((4, 4 + len(rec)), (0, 0), (0, 0))), stats)
    assert [(o.kind, o.type, o.label, o.coords) for o in objs] == [
        ("polygon", 0x10301, 7, [(1002, 2003), (1003, 2005)]),
    ]
    assert stats.bad_sections == 0


def test_extended_point_with_poi_label():
    rec = bytes([0x2C, 0x25, 0x01, 0x00, 0x02, 0x00, 0x09, 0x00, 0x40])
    stats = DecodeStats()
    objs = decode_subdivision(rec, sub(0, 0, 0, ext=((0, 0), (0, 0), (0, len(rec)))), stats)
    assert [(o.kind, o.type, o.label, o.label_src, o.coords) for o in objs] == [
        ("point", 0x12C05, 9, "poi", [(1001, 2002)]),
    ]


def test_misaligned_section_is_counted():
    line = bytes([0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x95])
    stats = DecodeStats()
    objs = decode_subdivision(line + b"\x00", sub(0, len(line) + 1, KIND_LINES), stats)
    assert stats.bad_sections == 1
    assert objs == []


@pytest.mark.realdata
def test_real_tile_sections_align(detailed_img):
    rgn = detailed_img.get("14057403.RGN")
    t = parse_tre(detailed_img.get("14057403.TRE"), rgn)
    stats = DecodeStats()
    lat_ok = True
    sample = t.subdivisions[:1500] + t.subdivisions[-800:]  # the tail is past the 16 MB offset wrap
    for sd in sample:
        for obj in decode_subdivision(rgn, sd, stats):
            lat_ok &= all(62.9 < y * 360 / 2**24 < 65.2 for _, y in obj.coords)
    assert stats.sections > 1000
    assert stats.bad_sections == 0
    assert lat_ok
