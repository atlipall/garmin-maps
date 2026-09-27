from .binary import u16, u24, u32
from .errors import ImgError

FEET_TO_M = 0.3048
ELEVATION_SEPARATOR = 0x1F


def _is_number(s):
    try:
        float(s)
    except ValueError:
        return False
    return True


def format_label(raw, codec):
    parts = []
    buf = bytearray()
    last_sep = 0
    for b in raw:
        if 0x1B <= b <= 0x1F:
            last_sep = b
            if buf:
                parts.append((bytes(buf), last_sep))
                buf.clear()
        elif b >= 0x07:
            buf.append(b)
    if buf:
        parts.append((bytes(buf), last_sep))
    out = []
    for part, sep in parts:
        s = part.decode(codec, errors="replace").strip()
        if sep == ELEVATION_SEPARATOR and _is_number(s):
            s = f"{round(float(s) * FEET_TO_M)} m"
        if s:
            out.append(s)
    return " ".join(out) or None


class LabelTable:
    def __init__(self, lbl, net):
        if lbl[2:12] != b"GARMIN LBL":
            raise ImgError("LBL: bad signature")
        encoding = lbl[0x1E]
        if encoding != 9:
            raise ImgError(f"LBL: label encoding {encoding} not supported (only 8-bit labels, encoding 9)")
        self.lbl = lbl
        self.lbl1 = u32(lbl, 0x15)
        self.shift = lbl[0x1D]
        codepage = u16(lbl, 0xAA) if u16(lbl, 0) >= 0xAC else 1252
        self.codec = f"cp{codepage}" if codepage else "latin-1"
        self.poi_off = u32(lbl, 0x57)
        self.poi_shift = lbl[0x5F]
        self.net = net
        self.net1 = u32(net, 0x15) if net else 0
        self.net_shift = net[0x1D] if net else 0
        self._cache = {}

    def text(self, label, src):
        if src == "lbl" and label == 0:
            return None
        try:
            off = self._resolve(label, src)
            if not off:
                return None
            if off not in self._cache:
                start = self.lbl1 + (off << self.shift)
                end = self.lbl.find(b"\0", start)
                self._cache[off] = format_label(self.lbl[start:end], self.codec)
            return self._cache[off]
        except IndexError:
            return None

    def _resolve(self, label, src):
        if src == "poi":
            return u24(self.lbl, self.poi_off + (label << self.poi_shift)) & 0x3FFFFF
        if src == "net":
            if not self.net:
                return None
            v = u24(self.net, self.net1 + (label << self.net_shift))
            return None if v & 0x400000 else v & 0x3FFFFF
        return label
