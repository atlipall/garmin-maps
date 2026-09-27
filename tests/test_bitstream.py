from imgconv.bitstream import decode_deltas, setup


def test_same_sign_positive():
    # header: x same(1) x neg(0) y same(1) y neg(0); then x=1 (2 bits) y=2 (2 bits)
    assert decode_deltas(bytes([0x95]), 0x00, v2=False, extra_bit=False) == [(1, 2)]


def test_same_sign_negative_x():
    assert decode_deltas(bytes([0x97]), 0x00, v2=False, extra_bit=False) == [(-1, 2)]


def test_signed_values():
    # header: x not same, y not same (2 bits); x 3 bits = 7 -> -1, y 3 bits = 3
    assert decode_deltas(bytes([0x7C]), 0x00, v2=False, extra_bit=False) == [(-1, 3)]


def test_signed_escape_extends_magnitude():
    # x reads 4 (== sign bit => escape, acc 3) then 2 -> 5; y = 0
    assert decode_deltas(bytes([0x50, 0x00]), 0x00, v2=False, extra_bit=False) == [(5, 0)]


def test_extra_bit_is_skipped():
    # base 1/1 -> 3 bits each, extra bit before every pair
    assert decode_deltas(bytes([0x75, 0x05]), 0x11, v2=False, extra_bit=True) == [(3, 5)]


def test_v2_flag_bit_widens_coords():
    bx, by, sign = setup(0x00, 0x05 | 0x10, v2=True)
    assert (bx, by, sign.header_bits) == (3, 3, 5)


def test_v2_decode():
    # header 5 bits (x same +, y same +, v2 flag 0), x=1, y=2; trailing padding yields (0, 0)
    assert decode_deltas(bytes([0x25, 0x01]), 0x00, v2=True, extra_bit=False) == [(1, 2), (0, 0)]


def test_empty_bitstream_has_no_deltas():
    assert decode_deltas(b"", 0x00, v2=False, extra_bit=False) == []
