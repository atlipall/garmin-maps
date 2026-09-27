import struct
from dataclasses import dataclass, fields

from .binary import s16, u16, u24
from .bitstream import decode_deltas
from .tre import KIND_IDX_POINTS, KIND_LINES, KIND_POINTS, KIND_POLYGONS


@dataclass
class RawObject:
    kind: str
    type: int
    label: int
    label_src: str
    coords: list


@dataclass
class DecodeStats:
    sections: int = 0
    bad_sections: int = 0
    features: int = 0
    out_of_bounds: int = 0

    def add(self, other):
        for f in fields(self):
            setattr(self, f.name, getattr(self, f.name) + getattr(other, f.name))


def _walk(sd, dx, dy, deltas):
    x = sd.cx + (dx << sd.shift)
    y = sd.cy + (dy << sd.shift)
    coords = [(x, y)]
    for ddx, ddy in deltas:
        if ddx == 0 and ddy == 0:
            continue
        x += ddx << sd.shift
        y += ddy << sd.shift
        coords.append((x, y))
    return coords


def _bitstream(rgn, p, n):
    data = rgn[p:p + n]
    if len(data) < n:
        raise IndexError("bitstream runs past the end of RGN")
    return data


def _point(rgn, o, sd):
    lb = u24(rgn, o + 1)
    x = sd.cx + (s16(rgn, o + 4) << sd.shift)
    y = sd.cy + (s16(rgn, o + 6) << sd.shift)
    size, sub = 8, 0
    if lb & 0x800000:
        sub = rgn[o + 8]
        size = 9
    src = "poi" if lb & 0x400000 else "lbl"
    return size, RawObject("point", (rgn[o] << 8) | sub, lb & 0x3FFFFF, src, [(x, y)])


def _poly(rgn, o, sd, line):
    t = rgn[o]
    typ = t & 0x3F if line else t & 0x7F
    lb = u24(rgn, o + 1)
    dx, dy = s16(rgn, o + 4), s16(rgn, o + 6)
    if t & 0x80:
        n, p = u16(rgn, o + 8), o + 10
    else:
        n, p = rgn[o + 8], o + 9
    info = rgn[p]
    p += 1
    deltas = decode_deltas(_bitstream(rgn, p, n), info, v2=False, extra_bit=bool(lb & 0x400000))
    src = "net" if lb & 0x800000 else "lbl"
    return p + n - o, RawObject("line" if line else "polygon", typ, lb & 0x3FFFFF, src, _walk(sd, dx, dy, deltas))


def _poly2(rgn, o, sd, line):
    t, st = rgn[o], rgn[o + 1]
    dx, dy = s16(rgn, o + 2), s16(rgn, o + 4)
    p = o + 6
    if rgn[p] & 1 == 0:
        n = (u16(rgn, p) >> 2) - 1
        p += 2
    else:
        n = (rgn[p] >> 1) - 1
        p += 1
    info = rgn[p]
    p += 1
    deltas = decode_deltas(_bitstream(rgn, p, n), info, v2=True, extra_bit=False)
    p += n
    label = 0
    if st & 0x20:
        label = u24(rgn, p) & 0x3FFFFF
        p += 3
    typ = 0x10000 | (t << 8) | (st & 0x1F)
    return p - o, RawObject("line" if line else "polygon", typ, label, "lbl", _walk(sd, dx, dy, deltas))


def _point2(rgn, o, sd):
    t, st = rgn[o], rgn[o + 1]
    x = sd.cx + (s16(rgn, o + 2) << sd.shift)
    y = sd.cy + (s16(rgn, o + 4) << sd.shift)
    size, label, src = 6, 0, "lbl"
    if st & 0x20:
        lb = u24(rgn, o + 6)
        label = lb & 0x3FFFFF
        src = "poi" if lb & 0x400000 else "lbl"
        size += 3
    if st & 0x80:
        size += 1
    return size, RawObject("point", 0x10000 | (t << 8) | (st & 0x1F), label, src, [(x, y)])


def _run(stats, out, start, end, decode_one):
    stats.sections += 1
    o = start
    local = []
    try:
        while o < end:
            size, obj = decode_one(o)
            o += size
            local.append(obj)
    except (IndexError, struct.error):
        stats.bad_sections += 1
        return
    if o != end:
        stats.bad_sections += 1
        return
    out.extend(local)


_SECTIONS = (KIND_POINTS, KIND_IDX_POINTS, KIND_LINES, KIND_POLYGONS)


def decode_subdivision(rgn, sd, stats):
    out = []
    present = [k for k in _SECTIONS if sd.kinds & k]
    if present and sd.rgn_end > sd.rgn_start:
        first = sd.rgn_start + 2 * (len(present) - 1)
        starts = [first] + [sd.rgn_start + u16(rgn, sd.rgn_start + 2 * i) for i in range(len(present) - 1)]
        ends = starts[1:] + [sd.rgn_end]
        for kind, start, end in zip(present, starts, ends):
            if kind in (KIND_POINTS, KIND_IDX_POINTS):
                _run(stats, out, start, end, lambda o: _point(rgn, o, sd))
            else:
                is_line = kind == KIND_LINES
                _run(stats, out, start, end, lambda o, is_line=is_line: _poly(rgn, o, sd, is_line))
    (pg_a, pg_e), (ln_a, ln_e), (pt_a, pt_e) = sd.ext
    if pg_e > pg_a:
        _run(stats, out, pg_a, pg_e, lambda o: _poly2(rgn, o, sd, False))
    if ln_e > ln_a:
        _run(stats, out, ln_a, ln_e, lambda o: _poly2(rgn, o, sd, True))
    if pt_e > pt_a:
        _run(stats, out, pt_a, pt_e, lambda o: _point2(rgn, o, sd))
    return out
