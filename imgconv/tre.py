from dataclasses import dataclass

from .binary import map_units_to_deg, s24, u16, u24, u32
from .errors import ImgError

KIND_POINTS = 0x10
KIND_IDX_POINTS = 0x20
KIND_LINES = 0x40
KIND_POLYGONS = 0x80
EMPTY_EXT = ((0, 0), (0, 0), (0, 0))


@dataclass
class Level:
    number: int
    bits: int
    inherited: bool
    count: int


@dataclass
class Subdivision:
    index: int
    level: Level
    kinds: int
    cx: int
    cy: int
    rgn_start: int
    rgn_end: int
    ext: tuple = EMPTY_EXT

    @property
    def shift(self):
        return 24 - self.level.bits

    @property
    def has_data(self):
        return bool(self.kinds) or any(end > start for start, end in self.ext)


@dataclass
class Tre:
    north: float
    east: float
    south: float
    west: float
    levels: list
    subdivisions: list


def parse_tre(tre, rgn):
    if tre[2:12] != b"GARMIN TRE":
        raise ImgError("TRE: bad signature")
    if rgn[2:12] != b"GARMIN RGN":
        raise ImgError("RGN: bad signature")
    hlen = u16(tre, 0)
    if hlen >= 0xAE and any(tre[0x9A:0xAE]):
        raise ImgError("TRE is encrypted (non-zero key); locked maps are not supported")
    if tre[0x0D] & 0x80:
        raise ImgError("TRE is marked locked; locked maps are not supported")

    lo, ls = u32(tre, 0x21), u32(tre, 0x25)
    levels = [Level(tre[lo + i] & 0x0F, tre[lo + i + 1], bool(tre[lo + i] & 0x80), u16(tre, lo + i + 2))
              for i in range(0, ls, 4)]

    rgn_off, rgn_len = u32(rgn, 0x15), u32(rgn, 0x19)
    subs = []
    p = u32(tre, 0x29)
    wrap = 0
    prev = -1
    for li, level in enumerate(levels):
        rec = 14 if li == len(levels) - 1 else 16
        for _ in range(level.count):
            r = u24(tre, p) + wrap
            if r < prev:
                # RGN offsets are 24-bit; sections over 16 MB wrap around
                wrap += 1 << 24
                r += 1 << 24
            prev = r
            subs.append(Subdivision(len(subs), level, tre[p + 3], s24(tre, p + 4), s24(tre, p + 7),
                                    rgn_off + r, 0))
            p += rec
    for a, b in zip(subs, subs[1:]):
        a.rgn_end = b.rgn_start
    if subs:
        subs[-1].rgn_end = rgn_off + rgn_len
    _attach_ext(tre, rgn, hlen, subs)

    return Tre(map_units_to_deg(s24(tre, 0x15)), map_units_to_deg(s24(tre, 0x18)),
               map_units_to_deg(s24(tre, 0x1B)), map_units_to_deg(s24(tre, 0x1E)), levels, subs)


def _attach_ext(tre, rgn, hlen, subs):
    if hlen < 0x86 or u16(rgn, 0) < 0x5D:
        return
    off, size, rec = u32(tre, 0x7C), u32(tre, 0x80), u16(tre, 0x84)
    if not size or rec < 12:
        return
    sections = [(u32(rgn, 0x1D), u32(rgn, 0x21)), (u32(rgn, 0x39), u32(rgn, 0x3D)), (u32(rgn, 0x55), u32(rgn, 0x59))]
    records = []
    for i in range(size // rec):
        o = off + i * rec
        records.append((u32(tre, o), u32(tre, o + 4), u32(tre, o + 8) if rec >= 13 else 0))
    for i, sd in enumerate(subs[:len(records)]):
        ext = []
        for k, (sect_off, sect_len) in enumerate(sections):
            start = records[i][k]
            end = records[i + 1][k] if i + 1 < len(records) else sect_len
            if k == 2 and rec < 13:
                start = end = 0
            ext.append((sect_off + start, sect_off + end))
        sd.ext = tuple(ext)
