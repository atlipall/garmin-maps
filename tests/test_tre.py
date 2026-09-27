import pytest

from imgconv.errors import ImgError
from imgconv.tre import KIND_LINES, KIND_POINTS, parse_tre
from tests.builders import make_rgn_header, make_tre

LEVELS = [(1, 22, False, 1), (0, 24, False, 2)]


def test_levels_and_subdivisions():
    rgn = make_rgn_header(300)
    tre = make_tre(LEVELS, [(0, KIND_POINTS, 100, 200), (40, KIND_LINES, -5, 7), (90, 0, 1, 2)])
    t = parse_tre(tre, rgn)
    assert [(lv.number, lv.bits) for lv in t.levels] == [(1, 22), (0, 24)]
    subs = t.subdivisions
    assert [(s.rgn_start, s.rgn_end) for s in subs] == [(0x7D, 0x7D + 40), (0x7D + 40, 0x7D + 90), (0x7D + 90, 0x7D + 300)]
    assert (subs[0].shift, subs[1].shift) == (2, 0)
    assert (subs[1].cx, subs[1].cy, subs[1].kinds) == (-5, 7, KIND_LINES)
    assert t.north == pytest.approx(1000 * 360 / 2**24)


def test_unwraps_24bit_rgn_offsets():
    rgn = make_rgn_header(0x1000100)
    tre = make_tre(LEVELS, [(0, 0, 0, 0), (0xFFFFF0, 0, 0, 0), (0x10, 0, 0, 0)])
    subs = parse_tre(tre, rgn).subdivisions
    assert subs[2].rgn_start == 0x7D + 0x1000010
    assert subs[1].rgn_end == subs[2].rgn_start


def test_ext_offsets():
    rgn = make_rgn_header(10, ext=((500, 60), (600, 0), (700, 12)))
    tre = make_tre(LEVELS, [(0, 0, 0, 0)] * 3, ext_records=[(0, 0, 0), (20, 0, 0), (20, 0, 12), (60, 0, 12)])
    subs = parse_tre(tre, rgn).subdivisions
    assert subs[0].ext == ((500, 520), (600, 600), (700, 700))
    assert subs[1].ext == ((520, 520), (600, 600), (700, 712))
    assert subs[2].ext == ((520, 560), (600, 600), (712, 712))
    assert subs[0].has_data and subs[1].has_data


def test_locked_tre_is_rejected():
    tre = bytearray(make_tre(LEVELS, [(0, 0, 0, 0)] * 3))
    tre[0x0D] = 0x80
    with pytest.raises(ImgError, match="locked"):
        parse_tre(bytes(tre), make_rgn_header(10))


@pytest.mark.realdata
def test_real_tre(detailed_img):
    t = parse_tre(detailed_img.get("14057403.TRE"), detailed_img.get("14057403.RGN"))
    assert [lv.bits for lv in t.levels] == [16, 18, 20, 22, 24]
    assert len(t.subdivisions) == 7892
    starts = [s.rgn_start for s in t.subdivisions]
    assert starts == sorted(starts)
    assert t.subdivisions[-1].rgn_end > 1 << 24
    assert 62.9 < t.south < t.north < 65.2
