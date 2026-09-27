"""Delta-coded polyline/polygon geometry (port of QMapShack's CShiftReg)."""
from dataclasses import dataclass


@dataclass
class SignInfo:
    x_signed: bool
    x_neg: bool
    y_signed: bool
    y_neg: bool
    header_bits: int


def coord_bits(base, signed):
    n = 2 + (base if base <= 9 else 2 * base - 9)
    return n + 1 if signed else n


def setup(base_info, first, v2):
    mask = 1
    header_bits = 2
    x_same = bool(first & mask)
    mask <<= 1
    x_neg = False
    if x_same:
        x_neg = bool(first & mask)
        mask <<= 1
        header_bits += 1
    bx = coord_bits(base_info & 0x0F, not x_same)
    y_same = bool(first & mask)
    mask <<= 1
    y_neg = False
    if y_same:
        y_neg = bool(first & mask)
        mask <<= 1
        header_bits += 1
    by = coord_bits((base_info >> 4) & 0x0F, not y_same)
    if v2:
        header_bits += 1
        if first & mask:
            bx += 1
            by += 1
    return bx, by, SignInfo(not x_same, x_neg, not y_same, y_neg, header_bits)


class _Reader:
    def __init__(self, data, bx, by, sign, extra_bit):
        self.data = data
        self.pos = 0
        self.reg = 0
        self.bits = 0
        self.bx = bx
        self.by = by
        self.sign = sign
        self.extra = extra_bit
        self.per = bx + by + (1 if extra_bit else 0)
        self._fill(self.per + sign.header_bits)
        self.reg >>= sign.header_bits
        self.bits -= sign.header_bits

    def _fill(self, n):
        while self.bits < n and self.pos < len(self.data):
            self.reg |= self.data[self.pos] << self.bits
            self.pos += 1
            self.bits += 8

    def _take(self, n):
        v = self.reg & ((1 << n) - 1)
        self.reg >>= n
        self.bits -= n
        return v

    def _value(self, n, signed, neg):
        if not signed:
            v = self._take(n)
            return -v if neg else v
        sign_bit = 1 << (n - 1)
        mask = (1 << n) - 1
        acc = 0
        while True:
            t = self.reg & mask
            if t != sign_bit:
                break
            acc += t - 1
            self._take(n)
            self._fill(self.bx + self.by)
        self._take(n)
        return acc + t if t < sign_bit else t - (sign_bit << 1) - acc

    def deltas(self):
        out = []
        while self.bits >= self.per:
            if self.extra:
                self._take(1)
            x = self._value(self.bx, self.sign.x_signed, self.sign.x_neg)
            y = self._value(self.by, self.sign.y_signed, self.sign.y_neg)
            self._fill(self.per)
            out.append((x, y))
        return out


def decode_deltas(data, base_info, v2, extra_bit):
    if not data:
        return []
    bx, by, sign = setup(base_info, data[0], v2)
    return _Reader(data, bx, by, sign, extra_bit).deltas()
