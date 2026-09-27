import struct


def u16(b, o):
    return struct.unpack_from("<H", b, o)[0]


def s16(b, o):
    return struct.unpack_from("<h", b, o)[0]


def u24(b, o):
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)


def s24(b, o):
    v = u24(b, o)
    return v - 0x1000000 if v & 0x800000 else v


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def map_units_to_deg(v):
    return v * 360.0 / (1 << 24)
