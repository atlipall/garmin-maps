import struct

import pytest

from imgconv.errors import ImgError
from imgconv.lbl import LabelTable, format_label
from imgconv.rgn import DecodeStats, decode_subdivision
from imgconv.tre import parse_tre


def make_lbl(strings, encoding=9, poi=b""):
    hlen = 0xAC
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN LBL"
    data = b"\0" + b"".join(s + b"\0" for s in strings)
    struct.pack_into("<II", h, 0x15, hlen, len(data))
    h[0x1E] = encoding
    struct.pack_into("<II", h, 0x57, hlen + len(data), len(poi))
    struct.pack_into("<H", h, 0xAA, 1252)
    return bytes(h) + data + poi


def test_icelandic_codepage():
    assert format_label(b"G\xf6nguskar\xf0", "cp1252") == "Gönguskarð"


def test_elevation_suffix_in_feet_becomes_metres():
    assert format_label(b"HEKLA\x1f4892", "cp1252") == "HEKLA 1491 m"


def test_control_bytes_are_dropped():
    assert format_label(b"\x01A\x1bB", "cp1252") == "A B"


def test_elevation_with_following_separator():
    assert format_label(b"A\x1f4892\x1bXYZ", "cp1252") == "A 1491 m XYZ"


def test_lookup_by_offset_and_poi():
    lbl = make_lbl([b"Vatn", b"Hraun"], poi=bytes([6, 0, 0]))
    table = LabelTable(lbl, None)
    assert table.text(1, "lbl") == "Vatn"
    assert table.text(6, "lbl") == "Hraun"
    assert table.text(0, "lbl") is None
    assert table.text(0, "poi") == "Hraun"


def test_net_label():
    lbl = make_lbl([b"Hringvegur"])
    net = bytearray(0x20)
    net[2:12] = b"GARMIN NET"
    struct.pack_into("<I", net, 0x15, 0x20)
    net += bytes([1, 0, 0x80])  # label offset 1, "last label" bit 23
    assert LabelTable(lbl, bytes(net)).text(0, "net") == "Hringvegur"


def test_unsupported_encoding():
    with pytest.raises(ImgError, match="encoding 6"):
        LabelTable(make_lbl([b"X"], encoding=6), None)


@pytest.mark.realdata
def test_real_labels(detailed_img):
    img = detailed_img
    rgn = img.get("14057403.RGN")
    tre = parse_tre(img.get("14057403.TRE"), rgn)
    table = LabelTable(img.get("14057403.LBL"), img.get("14057403.NET"))
    stats = DecodeStats()
    names = set()
    for sd in tre.subdivisions[938:1400]:
        for obj in decode_subdivision(rgn, sd, stats):
            name = table.text(obj.label, obj.label_src)
            if name:
                names.add(name)
    assert {"Gönguskarð", "Drífandi"} <= names
