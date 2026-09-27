# Garmin IMG → MBTiles Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the GPSmap.is Garmin IMG maps (+ SRTM `.hgt` DEM) into offline raster `.mbtiles` (z5–z15, with hillshade) that an iOS map app such as Guru Maps can open.

**Architecture:** A Python package `imgconv` decodes the Garmin IMG (container → TRE/RGN/LBL/NET → GeoJSONSeq) and turns its TYP file into a MapLibre style + sprite. tippecanoe builds vector MBTiles, GDAL builds terrain-RGB DEM MBTiles, and a Node renderer (headless `@maplibre/maplibre-gl-native`) renders 8×8 metatiles and crops them into 256-px raster tiles.

**Tech Stack:** Python 3.13 (stdlib + Pillow, pytest), tippecanoe 2.x, GDAL 3.x (Homebrew), Node 24 with `@maplibre/maplibre-gl-native`, `better-sqlite3`, `sharp`.

**Spec:** `docs/superpowers/specs/2026-09-27-garmin-img-to-mbtiles-design.md`

## Global Constraints

- Inputs live in `GPSmap.is 2024.21 Android/` (gitignored, never committed): `MAPS - Add content to MAPFILES folder/*.img` and `HILLSHADE - Add content to DEM folder/*.hgt`.
- All generated output goes under `out/` (gitignored).
- Output raster MBTiles: 256-px tiles, raster zooms **5–15**, PNG by default.
- **Zoom convention:** everything inside the vector pipeline and the style uses MapLibre zoom (512-px world). Raster zoom Z is rendered at MapLibre zoom Z−1. Vector tiles therefore span z4–z14.
- Level→zoom mapping: `minzoom = level_bits − 11`, clamped to 4–14; the coarsest level with data starts at 4.
- The converter must **fail loudly** (raise `ImgError` with subfile and reason) on encrypted/locked tiles or unsupported label encodings. The decode fails if more than 1% of RGN sections are misaligned or more than 1% of features fall outside Iceland (lon −26.5…−11.5, lat 62.5…67.5).
- Facts verified on the real files (2026-09-27): images are unscrambled (XOR byte 0), block size 4096; FAT starts at 0x1000 (zero slots before it); FAT part number is big-endian at entry 0x10–0x11; each IMG has 5 tiles (e.g. 14057401..06, no 04), levels 24/22/20/18/16 bits, where the 16-bit level is inherited and empty; LBL encoding 9 (8-bit), codepage 1252, all address shifts 0; RGN sections are up to 25 MB so **24-bit subdivision RGN offsets wrap and must be unwrapped**; tiles contain extended types (RGN2/3/4, TRE ext record size 13); contour labels are feet; the DEM is SRTM3 (1201×1201).
- Reference decoder: QMapShack (`src/qmapshack/map/garmin/CGarminPolygon.cpp`, `CGarminPoint.cpp`, `CGarminTyp.cpp`, `map/CMapIMG.cpp`). Consult it if a real-data test fails.
- Python venv at `.venv`; run tests with `.venv/bin/pytest`. Node code lives in `render/` and runs tests with `node --test`.
- Commit after each task. The repo is at `/Users/atli/projects/maps` (branch `main`).

## File Structure

```
pyproject.toml
imgconv/__init__.py
imgconv/errors.py          ImgError
imgconv/binary.py          little-endian readers, map-unit → degrees
imgconv/container.py       IMG disk image → subfiles
imgconv/bitstream.py       RGN geometry bitstream (delta decoder)
imgconv/tre.py             TRE header, levels, subdivisions (+ ext offsets)
imgconv/rgn.py             RGN objects per subdivision
imgconv/lbl.py             label lookup (LBL1, LBL6 POI, NET1)
imgconv/features.py        zoom bands, GeoJSON features, parallel decode
imgconv/typ.py             TYP styles (polygons, lines, points, draw order)
imgconv/fallback_styles.py default colours for types the TYP does not define
imgconv/stylegen.py        MapLibre style + sprite sheet
imgconv/mbtiles.py         write MBTiles from an XYZ directory
imgconv/tiling.py          tippecanoe wrapper
imgconv/hillshade.py       GDAL pipeline → terrain-RGB MBTiles
imgconv/cli.py             `imgconv` command
tests/builders.py          synthetic IMG/TRE/RGN/TYP byte builders
tests/test_*.py
render/package.json
render/lib/tiles.mjs       tile math, metatiles
render/lib/mbtiles.mjs     MBTiles reader/writer (better-sqlite3)
render/lib/renderer.mjs    headless MapLibre map with local request handler
render/worker.mjs          renders metatiles (child process)
render/render.mjs          CLI: `tiles` and `sample`
render/test/tiles.test.mjs
assets/fonts/<stack>/<range>.pbf   glyphs (committed)
README.md
```

---

### Task 1: Project scaffold and IMG container

**Files:**
- Create: `pyproject.toml`, `imgconv/__init__.py`, `imgconv/errors.py`, `imgconv/binary.py`, `imgconv/container.py`
- Create: `tests/__init__.py`, `tests/builders.py`, `tests/conftest.py`, `tests/test_container.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `ImgError(Exception)`; `binary.u16/s16/u24/s24/u32(buf, off) -> int`, `binary.map_units_to_deg(v) -> float`; `ImgContainer.from_path(path)`, `ImgContainer.from_bytes(data)`, `.subfiles: dict[str, bytes]` keyed `"NAME.EXT"`, `.tile_ids() -> list[str]`, `.get(name) -> bytes | None`, `.first_of_type(ext) -> bytes | None`. `tests/builders.build_img(files: dict[str, bytes], block_size=512, blocks_per_entry=240) -> bytes`. Pytest fixture `detailed_img` (session scope `ImgContainer`, skips when the real file is missing).

- [ ] **Step 1: Create the venv and package skeleton**

`pyproject.toml`:
```toml
[project]
name = "imgconv"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["Pillow>=10"]

[project.optional-dependencies]
dev = ["pytest>=8"]

[project.scripts]
imgconv = "imgconv.cli:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["imgconv"]

[tool.pytest.ini_options]
markers = ["realdata: needs the GPSmap.is files in the repo"]
```

Append to `.gitignore`:
```
.venv/
*.egg-info/
```

`imgconv/__init__.py` and `tests/__init__.py`: empty files.

`imgconv/errors.py`:
```python
class ImgError(Exception):
    """The input cannot be converted; the message names the subfile and the reason."""
```

`imgconv/binary.py`:
```python
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
```

Run:
```bash
cd /Users/atli/projects/maps && python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'
```
Expected: installs without error.

- [ ] **Step 2: Write the test builder and failing container tests**

`tests/builders.py`:
```python
import struct


def pack_s24(v):
    return (v & 0xFFFFFF).to_bytes(3, "little")


def build_img(files, block_size=512, blocks_per_entry=240):
    """Build a minimal Garmin IMG disk image holding `files` ({"NAME.EXT": bytes})."""
    layout = []
    fat_entries = 1
    for fname, data in files.items():
        nblocks = max(1, -(-len(data) // block_size))
        fat_entries += -(-nblocks // blocks_per_entry)
        layout.append((fname, data, nblocks))
    header_end = -(-(0x200 + 512 * fat_entries) // block_size) * block_size
    hdr = bytearray(header_end)
    hdr[0x10:0x16] = b"DSKIMG"
    hdr[0x61] = 9
    hdr[0x62] = block_size.bit_length() - 1 - 9

    def entry(name, ext, size, part, blocks):
        e = bytearray(512)
        e[0] = 1
        e[1:9] = name.ljust(8).encode()
        e[9:12] = ext.ljust(3).encode()
        struct.pack_into("<I", e, 0x0C, size)
        e[0x10] = part >> 8
        e[0x11] = part & 0xFF
        bl = list(blocks) + [0xFFFF] * (240 - len(blocks))
        struct.pack_into("<240H", e, 0x20, *bl)
        return e

    hdr[0x200:0x400] = entry("", "", header_end, 0, range(header_end // block_size))
    body = bytearray()
    next_block = header_end // block_size
    off = 0x400
    for fname, data, nblocks in layout:
        name, ext = fname.split(".")
        blocks = list(range(next_block, next_block + nblocks))
        for part, i in enumerate(range(0, nblocks, blocks_per_entry)):
            size = len(data) if part == 0 else 0
            hdr[off:off + 512] = entry(name, ext, size, part, blocks[i:i + blocks_per_entry])
            off += 512
        body += data.ljust(nblocks * block_size, b"\0")
        next_block += nblocks
    return bytes(hdr) + bytes(body)
```

`tests/conftest.py`:
```python
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "GPSmap.is 2024.21 Android"
MAPS = DATA / "MAPS - Add content to MAPFILES folder"
DETAILED = MAPS / "Iceland GPSmap.is 2024.21 Detailed.img"
HGT_DIR = DATA / "HILLSHADE - Add content to DEM folder"


@pytest.fixture(scope="session")
def detailed_img():
    if not DETAILED.exists():
        pytest.skip("real GPSmap.is data not present")
    from imgconv.container import ImgContainer
    return ImgContainer.from_path(DETAILED)
```

`tests/test_container.py`:
```python
import pytest

from imgconv.container import ImgContainer
from imgconv.errors import ImgError
from tests.builders import build_img


def test_reads_subfiles():
    files = {"00000001.TRE": b"T" * 700, "00000001.RGN": b"R" * 10, "103F2.TYP": b"Y" * 3}
    img = ImgContainer.from_bytes(build_img(files))
    assert img.subfiles == files
    assert img.tile_ids() == ["00000001"]
    assert img.first_of_type("TYP") == b"YYY"
    assert img.get("missing.XYZ") is None


def test_joins_multi_part_entries():
    data = bytes(range(256)) * 20  # 5120 bytes = 10 blocks of 512
    img = ImgContainer.from_bytes(build_img({"A.RGN": data}, blocks_per_entry=3))
    assert img.get("A.RGN") == data


def test_rejects_non_img():
    with pytest.raises(ImgError, match="DSKIMG"):
        ImgContainer.from_bytes(bytes(4096))


def test_rejects_scrambled():
    raw = bytearray(build_img({"A.TRE": b"x"}))
    raw[0] = 0x5A
    with pytest.raises(ImgError, match="XOR"):
        ImgContainer.from_bytes(bytes(raw))


@pytest.mark.realdata
def test_real_detailed_img(detailed_img):
    assert detailed_img.tile_ids() == ["14057401", "14057402", "14057403", "14057405", "14057406"]
    assert len(detailed_img.get("14057403.RGN")) == 17504055
    assert detailed_img.first_of_type("TYP")[2:12] == b"GARMIN TYP"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_container.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'imgconv.container'`.

- [ ] **Step 4: Implement the container**

`imgconv/container.py`:
```python
import struct
from dataclasses import dataclass
from pathlib import Path

from .binary import u32
from .errors import ImgError

FAT_ENTRY = 512


@dataclass
class ImgContainer:
    subfiles: dict[str, bytes]

    @classmethod
    def from_path(cls, path):
        return cls.from_bytes(Path(path).read_bytes())

    @classmethod
    def from_bytes(cls, data):
        if data[0] != 0:
            raise ImgError(f"XOR-scrambled IMG (xor byte 0x{data[0]:02x}) is not supported")
        if data[0x10:0x16] != b"DSKIMG":
            raise ImgError("not a Garmin IMG file (missing DSKIMG signature)")
        block_size = 1 << (data[0x61] + data[0x62])
        parts = {}
        header_end = None
        started = False
        off = 0x200
        while off + FAT_ENTRY <= len(data):
            if header_end is not None and off >= header_end:
                break
            e = data[off:off + FAT_ENTRY]
            off += FAT_ENTRY
            if e[0] != 1:
                if started:
                    break
                continue
            started = True
            name = e[1:9].decode("latin-1").strip()
            ext = e[9:12].decode("latin-1").strip()
            size = u32(e, 0x0C)
            part = (e[0x10] << 8) | e[0x11]
            blocks = [b for b in struct.unpack_from("<240H", e, 0x20) if b != 0xFFFF]
            if not name and not ext:
                # this entry describes the header area itself; its size ends the FAT
                header_end = size
                continue
            entry = parts.setdefault(f"{name}.{ext}", {"size": 0, "blocks": []})
            if part == 0:
                entry["size"] = size
            entry["blocks"].extend(blocks)
        if not parts:
            raise ImgError("no subfiles found in the IMG FAT")
        subfiles = {}
        for key, entry in parts.items():
            chunks = [data[b * block_size:(b + 1) * block_size] for b in entry["blocks"]]
            subfiles[key] = b"".join(chunks)[:entry["size"]]
        return cls(subfiles)

    def tile_ids(self):
        return sorted(k[:-4] for k in self.subfiles if k.endswith(".TRE"))

    def get(self, name):
        return self.subfiles.get(name)

    def first_of_type(self, ext):
        for key in sorted(self.subfiles):
            if key.endswith("." + ext):
                return self.subfiles[key]
        return None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_container.py -v`
Expected: 5 passed (the realdata test passes because the files are present).

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore imgconv tests
git commit -m "Add IMG container reader"
```

---

### Task 2: RGN geometry bitstream

**Files:**
- Create: `imgconv/bitstream.py`, `tests/test_bitstream.py`

**Interfaces:**
- Produces: `bitstream.decode_deltas(data: bytes, base_info: int, v2: bool, extra_bit: bool) -> list[tuple[int, int]]` (raw, unshifted deltas after the first point); `bitstream.setup(base_info, first_byte, v2) -> (bx, by, SignInfo)`.

- [ ] **Step 1: Write the failing tests**

The fixtures below were derived by hand from QMapShack's `CShiftReg`. The bit order is LSB first; the first 2–5 bits are the sign header.

`tests/test_bitstream.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_bitstream.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`imgconv/bitstream.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_bitstream.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add imgconv/bitstream.py tests/test_bitstream.py
git commit -m "Add RGN geometry bitstream decoder"
```

---

### Task 3: TRE parser

**Files:**
- Create: `imgconv/tre.py`, `tests/test_tre.py`
- Modify: `tests/builders.py` (add `make_rgn_header`, `make_tre`)

**Interfaces:**
- Consumes: `binary.*`, `ImgError`.
- Produces:
  - `Level(number: int, bits: int, inherited: bool, count: int)`.
  - `Subdivision(index, level: Level, kinds: int, cx: int, cy: int, rgn_start: int, rgn_end: int, ext: tuple[tuple[int,int], tuple[int,int], tuple[int,int]])`, with property `shift = 24 - level.bits` and `has_data` (kinds or any non-empty ext). All offsets are absolute within the RGN subfile. The `ext` order is (polygons2, lines2, points2).
  - `Tre(north, east, south, west: float, levels: list[Level], subdivisions: list[Subdivision])`.
  - `parse_tre(tre: bytes, rgn: bytes) -> Tre`.
  - Constants `KIND_POINTS=0x10, KIND_IDX_POINTS=0x20, KIND_LINES=0x40, KIND_POLYGONS=0x80`, `EMPTY_EXT`.

- [ ] **Step 1: Add builders**

Append to `tests/builders.py`:
```python
def make_rgn_header(data_len, ext=((0, 0), (0, 0), (0, 0)), hlen=0x7D):
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN RGN"
    struct.pack_into("<II", h, 0x15, hlen, data_len)
    for (o, n), at in zip(ext, (0x1D, 0x39, 0x55)):
        struct.pack_into("<II", h, at, o, n)
    return h


def make_tre(levels, subdivs, ext_records=None, hlen=0xBC, bounds=(1000, 1000, -1000, -1000), key=b""):
    """levels: [(number, bits, inherited, count)]; subdivs: [(rgn_offset, kinds, cx, cy)] in level order;
    ext_records: [(poly2, line2, point2)] offsets (one per subdivision + sentinel)."""
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN TRE"
    n, e, s, w = bounds
    h[0x15:0x18], h[0x18:0x1B], h[0x1B:0x1E], h[0x1E:0x21] = pack_s24(n), pack_s24(e), pack_s24(s), pack_s24(w)
    if key:
        h[0x9A:0x9A + len(key)] = key
    lv = b"".join(bytes([num | (0x80 if inh else 0), bits]) + struct.pack("<H", cnt)
                  for num, bits, inh, cnt in levels)
    sd = bytearray()
    i = 0
    for li, (_, _, _, cnt) in enumerate(levels):
        last = li == len(levels) - 1
        for _ in range(cnt):
            rgn_off, kinds, cx, cy = subdivs[i]
            sd += (rgn_off & 0xFFFFFF).to_bytes(3, "little") + bytes([kinds])
            sd += pack_s24(cx) + pack_s24(cy) + struct.pack("<HH", 10, 10)
            if not last:
                sd += struct.pack("<H", 0)
            i += 1
    ext = b"".join(struct.pack("<IIIB", a, b, c, 0) for a, b, c in (ext_records or []))
    lv_off = hlen
    sd_off = lv_off + len(lv)
    ext_off = sd_off + len(sd)
    struct.pack_into("<II", h, 0x21, lv_off, len(lv))
    struct.pack_into("<II", h, 0x29, sd_off, len(sd))
    struct.pack_into("<IIH", h, 0x7C, ext_off, len(ext), 13 if ext else 0)
    return bytes(h) + lv + bytes(sd) + ext
```

- [ ] **Step 2: Write the failing tests**

`tests/test_tre.py`:
```python
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


def test_encrypted_tre_is_rejected():
    tre = make_tre(LEVELS, [(0, 0, 0, 0)] * 3, key=b"\x01\x02")
    with pytest.raises(ImgError, match="encrypted"):
        parse_tre(tre, make_rgn_header(10))


@pytest.mark.realdata
def test_real_tre(detailed_img):
    t = parse_tre(detailed_img.get("14057403.TRE"), detailed_img.get("14057403.RGN"))
    assert [lv.bits for lv in t.levels] == [16, 18, 20, 22, 24]
    assert len(t.subdivisions) == 7892
    starts = [s.rgn_start for s in t.subdivisions]
    assert starts == sorted(starts)
    assert t.subdivisions[-1].rgn_end > 1 << 24
    assert 62.9 < t.south < t.north < 65.2
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_tre.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement**

`imgconv/tre.py`:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_tre.py -v`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add imgconv/tre.py tests/test_tre.py tests/builders.py
git commit -m "Add TRE parser with 24-bit offset unwrapping and ext sections"
```

---

### Task 4: RGN object decoder

**Files:**
- Create: `imgconv/rgn.py`, `tests/test_rgn.py`

**Interfaces:**
- Consumes: `Subdivision`, `Level`, `KIND_*`, `EMPTY_EXT` from `imgconv.tre`; `decode_deltas` from `imgconv.bitstream`.
- Produces:
  - `RawObject(kind: str, type: int, label: int, label_src: str, coords: list[tuple[int,int]])`, where `kind` is `"point"`, `"line"` or `"polygon"` and `label_src` is `"lbl"`, `"poi"` or `"net"`. Coordinates are in Garmin map units as (lon, lat).
  - `DecodeStats` with fields `sections, bad_sections, features, out_of_bounds` (ints) and `add(other)`.
  - `decode_subdivision(rgn: bytes, sd: Subdivision, stats: DecodeStats) -> list[RawObject]`.
- Type codes: a standard point is `(type << 8) | subtype`, and a standard line or polygon is its type byte. Extended types are `0x10000 | (type << 8) | (subtype & 0x1F)`.

- [ ] **Step 1: Write the failing tests**

`tests/test_rgn.py`:
```python
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
    decode_subdivision(line + b"\x00", sub(0, len(line) + 1, KIND_LINES), stats)
    assert stats.bad_sections == 1


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_rgn.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`imgconv/rgn.py`:
```python
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
    try:
        while o < end:
            size, obj = decode_one(o)
            o += size
            out.append(obj)
    except (IndexError, struct.error):
        stats.bad_sections += 1
        return
    if o != end:
        stats.bad_sections += 1


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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_rgn.py -v`
Expected: 5 passed. If `test_real_tile_sections_align` fails, compare against QMapShack `CMapIMG::loadSubDiv` and `CGarminPolygon::decode/decode2` before changing the unit-test fixtures.

- [ ] **Step 5: Commit**

```bash
git add imgconv/rgn.py tests/test_rgn.py
git commit -m "Add RGN object decoder for standard and extended types"
```

---

### Task 5: Labels

**Files:**
- Create: `imgconv/lbl.py`, `tests/test_lbl.py`

**Interfaces:**
- Consumes: `binary.*`, `ImgError`.
- Produces: `format_label(raw: bytes, codec: str) -> str | None`; `LabelTable(lbl: bytes, net: bytes | None)` with `.text(label: int, src: str) -> str | None`, where `src` comes from `RawObject.label_src`.

- [ ] **Step 1: Write the failing tests**

`tests/test_lbl.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_lbl.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`imgconv/lbl.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_lbl.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add imgconv/lbl.py tests/test_lbl.py
git commit -m "Add label lookup with Icelandic codepage and elevation conversion"
```

---

### Task 6: Feature export, `decode` and `inspect` commands

**Files:**
- Create: `imgconv/features.py`, `imgconv/cli.py`, `tests/test_features.py`

**Interfaces:**
- Consumes: `ImgContainer`, `parse_tre`, `decode_subdivision`, `DecodeStats`, `RawObject`, `LabelTable`, `map_units_to_deg`.
- Produces:
  - `zoom_bands(bits: list[int]) -> dict[int, tuple[int, int]]`.
  - `to_feature(obj: RawObject, name: str | None, band: tuple[int, int]) -> dict | None`.
  - `contour_label(name: str) -> str`.
  - `decode_img(img_path: Path, out_dir: Path, workers: int) -> DecodeStats`, which writes `out_dir/features.geojsonseq`, `out_dir/types.json` (`{"points"|"lines"|"polygons": {"<decimal type>": count}}`) and `out_dir/decode-stats.json`, and raises `ImgError` if a threshold is exceeded.
  - CLI `imgconv inspect IMG` and `imgconv decode IMG [--out DIR] [--workers N]`.
  - Helpers in `cli.py` used by later tasks: `REPO`, `OUT`, `FONTS`, `HGT_DIR`, `slug(path) -> str`, `variant_dir(img) -> Path`.
- GeoJSON feature shape: `{"type":"Feature","tippecanoe":{"layer":L,"minzoom":a,"maxzoom":b},"properties":{"t":int,"name"?:str},"geometry":...}`.

- [ ] **Step 1: Write the failing tests**

`tests/test_features.py`:
```python
from imgconv.features import contour_label, in_bounds, to_feature, zoom_bands
from imgconv.rgn import RawObject

U = 2**24 / 360  # map units per degree


def test_zoom_bands_start_coarsest_at_4():
    assert zoom_bands([18, 20, 22, 24]) == {18: (4, 8), 20: (9, 10), 22: (11, 12), 24: (13, 14)}


def test_zoom_bands_single_level():
    assert zoom_bands([24]) == {24: (4, 14)}


def test_polygon_is_closed():
    obj = RawObject("polygon", 0x3C, 0, "lbl", [(0, 0), (int(U), 0), (int(U), int(U))])
    f = to_feature(obj, "Vatn", (9, 10))
    ring = f["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 4
    assert f["tippecanoe"] == {"layer": "polygons", "minzoom": 9, "maxzoom": 10}
    assert f["properties"] == {"t": 0x3C, "name": "Vatn"}


def test_degenerate_geometry_dropped():
    assert to_feature(RawObject("line", 1, 0, "lbl", [(0, 0)]), None, (4, 14)) is None
    assert to_feature(RawObject("polygon", 1, 0, "lbl", [(0, 0), (1, 1)]), None, (4, 14)) is None


def test_point_feature():
    f = to_feature(RawObject("point", 0x2F06, 0, "lbl", [(int(-20 * U), int(64 * U))]), None, (13, 14))
    assert f["geometry"]["type"] == "Point"
    assert f["geometry"]["coordinates"] == [round(int(-20 * U) / U, 6), round(int(64 * U) / U, 6)]
    assert "name" not in f["properties"]


def test_contour_label_feet_to_metres():
    assert contour_label("328") == "100"
    assert contour_label("Hekla") == "Hekla"


def test_in_bounds():
    assert in_bounds({"type": "Point", "coordinates": [-20.0, 64.0]})
    assert not in_bounds({"type": "Point", "coordinates": [10.0, 64.0]})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_features.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement features**

`imgconv/features.py`:
```python
import json
import os
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .binary import map_units_to_deg
from .container import ImgContainer
from .errors import ImgError
from .lbl import LabelTable
from .rgn import DecodeStats, decode_subdivision
from .tre import parse_tre

ZOOM_OFFSET = 11
MIN_ZOOM = 4
MAX_ZOOM = 14
MAX_ERROR_RATE = 0.01
CONTOUR_LINE_TYPES = frozenset(range(0x20, 0x26))
LAYERS = {"point": "points", "line": "lines", "polygon": "polygons"}
ICELAND = (-26.5, 62.5, -11.5, 67.5)  # w, s, e, n


def zoom_bands(bits):
    """Map level resolution (bits) to a (minzoom, maxzoom) band in MapLibre zoom."""
    levels = sorted(set(bits))
    starts = [MIN_ZOOM] + [min(MAX_ZOOM, max(MIN_ZOOM, b - ZOOM_OFFSET)) for b in levels[1:]]
    bands = {}
    for i, b in enumerate(levels):
        end = starts[i + 1] - 1 if i + 1 < len(levels) else MAX_ZOOM
        if end >= starts[i]:
            bands[b] = (starts[i], end)
    return bands


def contour_label(name):
    try:
        return str(round(float(name) * 0.3048))
    except ValueError:
        return name


def to_feature(obj, name, band):
    coords = [[round(map_units_to_deg(x), 6), round(map_units_to_deg(y), 6)] for x, y in obj.coords]
    if obj.kind == "point":
        geometry = {"type": "Point", "coordinates": coords[0]}
    elif obj.kind == "line":
        if len(coords) < 2:
            return None
        geometry = {"type": "LineString", "coordinates": coords}
    else:
        if len(coords) < 3:
            return None
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        geometry = {"type": "Polygon", "coordinates": [coords]}
    properties = {"t": obj.type}
    if name:
        properties["name"] = name
    return {"type": "Feature",
            "tippecanoe": {"layer": LAYERS[obj.kind], "minzoom": band[0], "maxzoom": band[1]},
            "properties": properties, "geometry": geometry}


def in_bounds(geometry):
    w, s, e, n = ICELAND
    coords = geometry["coordinates"]
    if geometry["type"] == "Point":
        coords = [coords]
    elif geometry["type"] == "Polygon":
        coords = coords[0]
    return all(w <= x <= e and s <= y <= n for x, y in coords)


def decode_tile(img_path, tile_id, out_path):
    img = ImgContainer.from_path(img_path)
    rgn = img.get(f"{tile_id}.RGN")
    tre = parse_tre(img.get(f"{tile_id}.TRE"), rgn)
    labels = LabelTable(img.get(f"{tile_id}.LBL"), img.get(f"{tile_id}.NET"))
    bands = zoom_bands([sd.level.bits for sd in tre.subdivisions if sd.has_data])
    stats = DecodeStats()
    types = {layer: Counter() for layer in LAYERS.values()}
    with open(out_path, "w", encoding="utf-8") as f:
        for sd in tre.subdivisions:
            band = bands.get(sd.level.bits)
            if band is None or not sd.has_data:
                continue
            for obj in decode_subdivision(rgn, sd, stats):
                name = labels.text(obj.label, obj.label_src)
                if name and obj.kind == "line" and obj.type in CONTOUR_LINE_TYPES:
                    name = contour_label(name)
                feature = to_feature(obj, name, band)
                if feature is None:
                    continue
                if not in_bounds(feature["geometry"]):
                    stats.out_of_bounds += 1
                    continue
                f.write(json.dumps(feature, ensure_ascii=False, separators=(",", ":")) + "\n")
                types[LAYERS[obj.kind]][obj.type] += 1
                stats.features += 1
    return tile_id, stats, types


def decode_img(img_path, out_dir, workers=os.cpu_count()):
    img_path, out_dir = Path(img_path), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tile_ids = ImgContainer.from_path(img_path).tile_ids()
    total = DecodeStats()
    types = {layer: Counter() for layer in LAYERS.values()}
    parts = [out_dir / f"part-{tid}.geojsonseq" for tid in tile_ids]
    with ProcessPoolExecutor(max_workers=min(workers, len(tile_ids))) as pool:
        for tile_id, stats, tile_types in pool.map(decode_tile, [img_path] * len(tile_ids), tile_ids, parts):
            print(f"  tile {tile_id}: {stats.features} features, "
                  f"{stats.bad_sections}/{stats.sections} bad sections, {stats.out_of_bounds} out of bounds")
            total.add(stats)
            for layer, counter in tile_types.items():
                types[layer].update(counter)
    with open(out_dir / "features.geojsonseq", "wb") as out:
        for part in parts:
            with open(part, "rb") as f:
                while chunk := f.read(1 << 24):
                    out.write(chunk)
            part.unlink()
    (out_dir / "types.json").write_text(json.dumps(
        {layer: {str(t): n for t, n in sorted(c.items())} for layer, c in types.items()}, indent=1))
    (out_dir / "decode-stats.json").write_text(json.dumps(total.__dict__, indent=1))
    if total.sections and total.bad_sections / total.sections > MAX_ERROR_RATE:
        raise ImgError(f"{total.bad_sections} of {total.sections} RGN sections failed to decode")
    if total.features and total.out_of_bounds / total.features > MAX_ERROR_RATE:
        raise ImgError(f"{total.out_of_bounds} features fell outside Iceland")
    return total
```

- [ ] **Step 4: Implement the CLI (inspect + decode)**

`imgconv/cli.py`:
```python
import argparse
import os
import re
import sys
from pathlib import Path

from .container import ImgContainer
from .errors import ImgError
from .features import decode_img
from .lbl import LabelTable
from .tre import parse_tre

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "out"
FONTS = REPO / "assets" / "fonts"
HGT_DIR = REPO / "GPSmap.is 2024.21 Android" / "HILLSHADE - Add content to DEM folder"


def slug(path):
    return re.sub(r"[^a-z0-9]+", "-", Path(path).stem.lower()).strip("-")


def variant_dir(img):
    return OUT / slug(img)


def cmd_inspect(args):
    img = ImgContainer.from_path(args.img)
    for name in sorted(img.subfiles):
        print(f"{name:16} {len(img.subfiles[name]):>10}")
    for tid in img.tile_ids():
        tre = parse_tre(img.get(f"{tid}.TRE"), img.get(f"{tid}.RGN"))
        LabelTable(img.get(f"{tid}.LBL"), img.get(f"{tid}.NET"))
        with_ext = sum(1 for sd in tre.subdivisions if any(e > s for s, e in sd.ext))
        print(f"tile {tid}: N{tre.north:.3f} S{tre.south:.3f} W{tre.west:.3f} E{tre.east:.3f} "
              f"levels={[lv.bits for lv in tre.levels]} subdivisions={len(tre.subdivisions)} "
              f"with-ext={with_ext}")


def cmd_decode(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    stats = decode_img(Path(args.img), out, args.workers)
    print(f"decoded {stats.features} features into {out / 'features.geojsonseq'}")


def build_parser():
    p = argparse.ArgumentParser(prog="imgconv", description="Garmin IMG to MBTiles converter")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("inspect", help="print IMG structure and fail on unsupported tiles")
    s.add_argument("img")
    s.set_defaults(func=cmd_inspect)
    s = sub.add_parser("decode", help="IMG -> features.geojsonseq + types.json")
    s.add_argument("img")
    s.add_argument("--out")
    s.add_argument("--workers", type=int, default=os.cpu_count())
    s.set_defaults(func=cmd_decode)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ImgError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run the unit tests**

Run: `.venv/bin/pytest -v`
Expected: all tests pass.

- [ ] **Step 6: Run inspect and a full decode on the real Detailed map**

Run:
```bash
.venv/bin/imgconv inspect "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
time .venv/bin/imgconv decode "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
cat out/iceland-gpsmap-is-2024-21-detailed/decode-stats.json
grep -c . out/iceland-gpsmap-is-2024-21-detailed/features.geojsonseq
grep -m1 -o '"name":"Reykjav[^"]*"' out/iceland-gpsmap-is-2024-21-detailed/features.geojsonseq
```
Expected: inspect lists 5 tiles with levels `[16, 18, 20, 22, 24]`. Decode prints one line per tile with `0/<n> bad sections`, `decode-stats.json` shows `"bad_sections": 0` and `"out_of_bounds"` below 1% of features, the feature count is in the millions, and a Reykjavík name is found. Record the wall time in the commit message.

- [ ] **Step 7: Commit**

```bash
git add imgconv/features.py imgconv/cli.py tests/test_features.py
git commit -m "Add feature export and decode/inspect commands"
```

---

### Task 7: TYP parser

**Files:**
- Create: `imgconv/typ.py`, `tests/test_typ.py`

**Interfaces:**
- Consumes: `binary.*`, `ImgError`; Pillow.
- Produces:
  - `PolygonStyle(color: str, pattern: PIL.Image | None)`.
  - `LineStyle(color: str, width: float, border_color: str | None, border_width: float, dash: list[float] | None)`.
  - `PointStyle(image: PIL.Image)`.
  - `Typ(polygons: dict[int, PolygonStyle], lines: dict[int, LineStyle], points: dict[int, PointStyle], draw_level: dict[int, int])`.
  - `parse_typ(data: bytes) -> Typ` and `empty_typ() -> Typ`.
- Colours are `"#rrggbb"`. Type keys use the same encoding as `RawObject.type`.

- [ ] **Step 1: Write the failing tests**

`tests/test_typ.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_typ.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`imgconv/typ.py`:
```python
"""TYP style file parser (port of the relevant parts of QMapShack's CGarminTyp)."""
from dataclasses import dataclass, field

from PIL import Image

from .binary import u32
from .errors import ImgError


@dataclass
class PolygonStyle:
    color: str
    pattern: Image.Image | None = None


@dataclass
class LineStyle:
    color: str
    width: float
    border_color: str | None = None
    border_width: float = 0
    dash: list | None = None


@dataclass
class PointStyle:
    image: Image.Image


@dataclass
class Typ:
    polygons: dict = field(default_factory=dict)
    lines: dict = field(default_factory=dict)
    points: dict = field(default_factory=dict)
    draw_level: dict = field(default_factory=dict)


def empty_typ():
    return Typ()


class _Reader:
    def __init__(self, data, pos=0):
        self.d = data
        self.pos = pos

    def u8(self):
        v = self.d[self.pos]
        self.pos += 1
        return v

    def u16(self):
        v = self.d[self.pos] | (self.d[self.pos + 1] << 8)
        self.pos += 2
        return v

    def u32(self):
        v = u32(self.d, self.pos)
        self.pos += 4
        return v

    def rgb(self):
        b, g, r = self.d[self.pos:self.pos + 3]
        self.pos += 3
        return (r, g, b, 255)


def _hex(rgba):
    return "#{:02x}{:02x}{:02x}".format(*rgba[:3])


def _indices(r, w, h, bpp):
    rows = []
    per_byte = 8 // bpp
    mask = (1 << bpp) - 1
    for _ in range(h):
        row = []
        while len(row) < w:
            byte = r.u8()
            for i in range(per_byte):
                if len(row) >= w:
                    break
                row.append((byte >> (i * bpp)) & mask)
        rows.append(row)
    return rows


def _image(rows, palette):
    img = Image.new("RGBA", (len(rows[0]), len(rows)), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(rows):
        for x, idx in enumerate(row):
            colour = palette[idx] if idx < len(palette) else None
            px[x, y] = colour if colour else (0, 0, 0, 0)
    return img


def _dash(rows):
    cols = [any(row[x] == 1 for row in rows) for x in range(len(rows[0]))]
    if all(cols) or not any(cols):
        return None
    start = next(i for i in range(len(cols)) if cols[i] and not cols[i - 1])
    seq = cols[start:] + cols[:start]
    runs = []
    for on in seq:
        if runs and runs[-1][0] == on:
            runs[-1][1] += 1
        else:
            runs.append([on, 1])
    return [float(n) / len(rows) for _, n in runs]


def _elements(data, array, data_offset):
    off, mod, size = array
    if not mod or not size or size % mod:
        return
    r = _Reader(data)
    for i in range(size // mod):
        r.pos = off + i * mod
        t16 = r.u16()
        if mod == 5:
            o = r.u16() | (r.u8() << 16)
        elif mod == 4:
            o = r.u16()
        elif mod == 3:
            o = r.u8()
        else:
            return
        yield t16, _Reader(data, data_offset + o)


def _line_polygon_type(t16):
    typ = ((t16 >> 5) | ((t16 & 0x1F) << 11)) & 0x7F
    return 0x10000 | (typ << 8) | (t16 & 0x1F) if t16 & 0x2000 else typ


def _point_type(t16):
    typ = ((t16 >> 5) | ((t16 & 0x1F) << 11)) & 0x7FF
    return 0x10000 | (typ << 8) | (t16 & 0x1F) if t16 & 0x2000 else (typ << 8) + (t16 & 0x1F)


def _polygon(r):
    ctyp = r.u8() & 0x0F
    if ctyp in (0x01, 0x06, 0x07):
        return PolygonStyle(_hex(r.rgb()))
    if ctyp in (0x08, 0x09, 0x0D):
        fg, bg = r.rgb(), r.rgb()
        if ctyp == 0x09:
            r.rgb(), r.rgb()
        elif ctyp == 0x0D:
            r.rgb()
        return PolygonStyle(_hex(fg), _image(_indices(r, 32, 32, 1), [bg, fg]))
    if ctyp in (0x0B, 0x0E, 0x0F):
        fg = r.rgb()
        if ctyp == 0x0B:
            r.rgb(), r.rgb()
        elif ctyp == 0x0F:
            r.rgb()
        return PolygonStyle(_hex(fg), _image(_indices(r, 32, 32, 1), [None, fg]))
    return None


_LINE_COLOURS = {0x00: 2, 0x01: 4, 0x03: 3, 0x05: 3, 0x06: 1, 0x07: 2}


def _line(r):
    f1 = r.u8()
    r.u8()
    ctyp, rows = f1 & 0x07, f1 >> 3
    ncolours = _LINE_COLOURS.get(ctyp)
    if ncolours is None:
        return None
    colours = [r.rgb() for _ in range(ncolours)]
    day = _hex(colours[0])
    if rows:
        return LineStyle(day, rows, dash=_dash(_indices(r, 32, rows, 1)))
    if ctyp in (0x00, 0x01, 0x03):
        w1, w2 = r.u8(), r.u8()
    else:
        w1, w2 = r.u8(), 0
    if ctyp in (0x00, 0x01) and w2 > w1:
        return LineStyle(day, w1, _hex(colours[1]), w2)
    return LineStyle(day, w1)


def _bpp(ncolors, flags):
    if flags == 0x00:
        table = [(3, ncolors), (4, 2), (16, 4), (256, 8)]
    elif flags == 0x10:
        if ncolors == 0:
            return 1
        table = [(3, 2), (15, 4), (256, 8)]
    elif flags == 0x20:
        if ncolors == 0:
            return 16
        table = [(3, ncolors), (4, 2), (16, 4), (256, 8)]
    else:
        return None
    for limit, bpp in table:
        if ncolors < limit:
            return bpp
    return None


def _colour_table(r, n, alpha):
    if not alpha:
        return [r.rgb() for _ in range(n)]
    out, reg, bits = [], 0, 0
    for _ in range(n):
        while bits < 28:
            reg = (reg & ~(0xFF << bits)) | (r.u8() << bits)
            bits += 8
        a = round((15 - ((reg >> 24) & 0x0F)) * 255 / 15)
        out.append(((reg >> 16) & 0xFF, (reg >> 8) & 0xFF, reg & 0xFF, a))
        reg >>= 28
        bits -= 28
    return out


def _point(r):
    r.u8()
    w, h, ncolors, flags = r.u8(), r.u8(), r.u8(), r.u8()
    bpp = _bpp(ncolors, flags)
    if not bpp or bpp >= 16 or not w or not h:
        return None
    palette = _colour_table(r, ncolors, flags == 0x20)
    return PointStyle(_image(_indices(r, w, h, bpp), palette))


def _draw_levels(data, array):
    off, mod, size = array
    levels = {}
    if mod != 5 or not size or size % 5:
        return levels
    level = 1
    for i in range(size // 5):
        typ = data[off + i * 5]
        mask = u32(data, off + i * 5 + 1)
        if typ == 0:
            level += 1
        elif mask == 0:
            levels[typ] = level
        else:
            for n in range(32):
                if mask & (1 << n):
                    levels[0x10000 | (typ << 8) | n] = level
    return levels


def parse_typ(data):
    if data[2:12] != b"GARMIN TYP":
        raise ImgError("TYP: bad signature")
    r = _Reader(data, 0x17)
    points_data = (r.u32(), r.u32())
    lines_data = (r.u32(), r.u32())
    polygons_data = (r.u32(), r.u32())
    r.u16(), r.u16()  # product id, family id
    arrays = [(r.u32(), r.u16(), r.u32()) for _ in range(4)]
    typ = Typ(draw_level=_draw_levels(data, arrays[3]))
    for t16, er in _elements(data, arrays[0], points_data[0]):
        style = _point(er)
        if style:
            typ.points[_point_type(t16)] = style
    for t16, er in _elements(data, arrays[1], lines_data[0]):
        style = _line(er)
        if style:
            typ.lines[_line_polygon_type(t16)] = style
    for t16, er in _elements(data, arrays[2], polygons_data[0]):
        style = _polygon(er)
        if style:
            typ.polygons[_line_polygon_type(t16)] = style
    return typ
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_typ.py -v`
Expected: 6 passed. If `test_real_typ` finds fewer styles than asserted, print the unhandled `ctyp` values. Add cases only by porting the matching branch from QMapShack's `CGarminTyp.cpp`; do not lower the thresholds.

- [ ] **Step 5: Commit**

```bash
git add imgconv/typ.py tests/test_typ.py
git commit -m "Add TYP style parser"
```

---

### Task 8: MapLibre style, sprite and `style` command

**Files:**
- Create: `imgconv/fallback_styles.py`, `imgconv/stylegen.py`, `tests/test_stylegen.py`
- Create: `assets/fonts/<stack>/<range>.pbf` (downloaded)
- Modify: `imgconv/cli.py` (add `style` command)

**Interfaces:**
- Consumes: `Typ`, `PolygonStyle`, `LineStyle`, `PointStyle`, `parse_typ`, `empty_typ`; `types.json` from Task 6.
- Produces: `build_style(typ: Typ, types: dict) -> tuple[dict, dict[str, Image]]`; `pack_sprite(images) -> tuple[Image, dict]`; `write_style(out_dir: Path, typ: Typ, types: dict) -> None`, which writes `style.json`, `sprite.png` and `sprite.json`; CLI `imgconv style IMG [--out DIR]`.
- The style uses sources `garmin` (`mbtiles://vector/{z}/{x}/{y}`, z4–14) and `dem` (`mbtiles://dem/{z}/{x}/{y}`, raster-dem, tileSize 256, z5–11), glyphs `fonts://{fontstack}/{range}.pbf` and sprite `sprite://sprite`. Sprite image names are `pg-<decimal type>` for fill patterns and `pt-<decimal type>` for POI icons. Font stacks are `Noto Sans Regular` and `Noto Sans Italic`.

- [ ] **Step 1: Download the glyphs**

```bash
for font in "Noto Sans Regular" "Noto Sans Italic"; do
  mkdir -p "assets/fonts/$font"
  for range in 0-255 256-511 8192-8447; do
    curl -sfL -o "assets/fonts/$font/$range.pbf" \
      "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/${font// /%20}/$range.pbf"
  done
done
ls -la assets/fonts/*
```
Expected: six non-empty `.pbf` files.

- [ ] **Step 2: Write the failing tests**

`tests/test_stylegen.py`:
```python
from PIL import Image

from imgconv.stylegen import build_style, pack_sprite
from imgconv.typ import LineStyle, PointStyle, PolygonStyle, Typ


def ids(style):
    return [layer["id"] for layer in style["layers"]]


def test_layer_order_and_sources():
    typ = Typ(polygons={0x3C: PolygonStyle("#0000ff"), 0x50: PolygonStyle("#00ff00")},
              lines={0x16: LineStyle("#ff0000", 3, "#000000", 5)},
              draw_level={0x50: 1, 0x3C: 2})
    types = {"polygons": {str(0x3C): 5, str(0x50): 9}, "lines": {str(0x16): 2, str(0x20): 1}, "points": {}}
    style, images = build_style(typ, types)
    order = ids(style)
    assert order[0] == "background"
    assert order.index("pg-80") < order.index("pg-60") < order.index("hillshade")
    # all casings go below all line fills; contours (32) sort below trails (22)
    assert order.index("hillshade") < order.index("ln-22-casing") < order.index("ln-32") < order.index("ln-22")
    assert style["sources"]["garmin"]["tiles"] == ["mbtiles://vector/{z}/{x}/{y}"]
    assert style["sources"]["dem"]["type"] == "raster-dem"
    assert style["glyphs"] == "fonts://{fontstack}/{range}.pbf"
    pg = next(layer for layer in style["layers"] if layer["id"] == "pg-60")
    assert pg["filter"] == ["==", ["get", "t"], 0x3C]
    assert pg["paint"]["fill-color"] == "#0000ff"


def test_pattern_and_icons_go_to_sprite():
    pattern = Image.new("RGBA", (32, 32), (1, 2, 3, 255))
    icon = Image.new("RGBA", (8, 8), (9, 9, 9, 255))
    typ = Typ(polygons={0x4E: PolygonStyle("#010203", pattern)}, points={0x2F06: PointStyle(icon)})
    types = {"polygons": {str(0x4E): 1}, "lines": {}, "points": {str(0x2F06): 3, str(0x6400): 1}}
    style, images = build_style(typ, types)
    assert set(images) == {"pg-78", "pt-12038"}
    pg = next(layer for layer in style["layers"] if layer["id"] == "pg-78")
    assert pg["paint"]["fill-pattern"] == "pg-78"
    icons = next(layer for layer in style["layers"] if layer["id"] == "poi-icons")
    assert icons["filter"] == ["in", ["get", "t"], ["literal", [0x2F06]]]


def test_unknown_types_fall_back_or_skip():
    types = {"polygons": {str(0x4A): 1, str(0x50): 1}, "lines": {str(0x01): 1}, "points": {}}
    style, _ = build_style(Typ(), types)
    assert "pg-74" not in ids(style)
    assert "pg-80" in ids(style)
    assert "ln-1" in ids(style)


def test_pack_sprite():
    images = {"a": Image.new("RGBA", (10, 20)), "b": Image.new("RGBA", (30, 5))}
    sheet, index = pack_sprite(images)
    assert index["a"] == {"x": 0, "y": 0, "width": 10, "height": 20, "pixelRatio": 1}
    assert index["b"]["x"] == 11
    assert sheet.size[1] >= 20
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_stylegen.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement the fallback table**

`imgconv/fallback_styles.py`:
```python
"""Default look for Garmin types the TYP file does not define."""

BACKGROUND = "#f4f0e4"

_WATER = "#a8d0ee"
_PARK = "#cde6b5"
POLYGON_COLORS = {
    0x01: "#e3d7c5", 0x02: "#e3d7c5", 0x03: "#e3d7c5", 0x04: "#d9d0c9", 0x05: "#dddddd", 0x06: "#dddddd",
    0x07: "#e0dcd8", 0x08: "#e8d9c5", 0x09: "#cfe0f0", 0x0A: "#e8e0d0", 0x0B: "#f0d8d8", 0x0C: "#ddd5e8",
    0x0D: "#d8e8c8", 0x0E: "#e0e0e0", 0x13: "#d6c4ac", 0x14: _PARK, 0x15: _PARK, 0x16: _PARK,
    0x17: "#d4ebbf", 0x18: "#d4ebbf", 0x19: "#dcebc9", 0x1A: "#d0dcc8", 0x1E: _PARK, 0x1F: _PARK, 0x20: _PARK,
    0x28: _WATER, 0x29: _WATER, 0x32: _WATER, 0x3B: _WATER, 0x3C: _WATER, 0x3D: _WATER, 0x3E: _WATER,
    0x3F: _WATER, 0x40: _WATER, 0x41: _WATER, 0x42: _WATER, 0x43: _WATER, 0x44: _WATER, 0x45: _WATER,
    0x46: _WATER, 0x47: _WATER, 0x48: _WATER, 0x49: _WATER, 0x4C: "#c4def0", 0x4D: "#fbfdff",
    0x4E: "#dcebc0", 0x4F: "#e0e8c8", 0x50: "#b8dba0", 0x51: "#c9e0d8", 0x52: "#e6ecd6", 0x53: "#f1e6c6",
}
# 0x4A is the map coverage definition and 0x4B the background; draw them only if the TYP styles them
SKIP_POLYGONS = {0x4A, 0x4B}

_TRACK = ("#a0703c", 1, [1, 1])
LINE_STYLES = {
    0x01: ("#d4413a", 4, None), 0x02: ("#e0662f", 3.5, None), 0x03: ("#f0a040", 3, None),
    0x04: ("#f5c060", 2.5, None), 0x05: ("#ffffff", 2, None), 0x06: ("#ffffff", 1.5, None),
    0x07: ("#ffffff", 1, None), 0x08: ("#f0a040", 2, None), 0x09: ("#f0a040", 2, None),
    0x0A: ("#a0703c", 1.5, [2, 1]), 0x0B: ("#f0a040", 2, None), 0x0C: ("#ffffff", 1.5, None),
    0x0D: _TRACK, 0x0E: _TRACK, 0x0F: _TRACK, 0x10: _TRACK, 0x11: _TRACK, 0x12: _TRACK, 0x13: _TRACK,
    0x14: ("#555555", 1.5, [3, 2]), 0x15: ("#4a86c5", 1, None), 0x16: ("#c0392b", 1, [2, 1.5]),
    0x18: ("#4a86c5", 1, None), 0x19: ("#999999", 1, [4, 2]), 0x1A: ("#3c78d8", 1, [3, 2]),
    0x1B: ("#3c78d8", 1, [3, 2]), 0x1C: ("#8e44ad", 1, [4, 2]), 0x1D: ("#8e44ad", 1, [3, 2]),
    0x1E: ("#8e44ad", 1.5, [5, 2]), 0x1F: ("#4a86c5", 2, None), 0x20: ("#c8a07a", 0.5, None),
    0x21: ("#c8a07a", 0.7, None), 0x22: ("#b08058", 1, None), 0x23: ("#7fa7c9", 0.5, None),
    0x24: ("#7fa7c9", 0.7, None), 0x25: ("#7fa7c9", 1, None), 0x26: ("#4a86c5", 1, [2, 1]),
    0x27: ("#888888", 3, None), 0x28: ("#777777", 1, [4, 2]), 0x29: ("#888888", 1, None),
    0x2A: ("#4a86c5", 1, [4, 2]), 0x2B: ("#d4413a", 1, [4, 2]),
}
DEFAULT_LINE = ("#888888", 1, None)

# higher draws later (on top)
LINE_PRIORITY = {
    **{t: 10 for t in range(0x20, 0x26)},
    **{t: 20 for t in (0x15, 0x18, 0x1F, 0x26)},
    **{t: 30 for t in (0x19, 0x1C, 0x1D, 0x1E, 0x2A, 0x2B)},
    **{t: 35 for t in (0x28, 0x29)},
    **{t: 40 for t in (0x14, 0x1A, 0x1B)},
    **{t: 50 for t in (0x0A, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x16)},
    **{t: 60 for t in (0x05, 0x06, 0x07, 0x0C)},
    **{t: 70 for t in (0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0B)},
}
DEFAULT_LINE_PRIORITY = 45
```

- [ ] **Step 5: Implement the style builder**

`imgconv/stylegen.py`:
```python
import json

from PIL import Image

from .fallback_styles import (BACKGROUND, DEFAULT_LINE, DEFAULT_LINE_PRIORITY, LINE_PRIORITY, LINE_STYLES,
                              POLYGON_COLORS, SKIP_POLYGONS)
from .features import CONTOUR_LINE_TYPES, MAX_ZOOM, MIN_ZOOM
from .typ import LineStyle

FONT_REGULAR = "Noto Sans Regular"
FONT_ITALIC = "Noto Sans Italic"
HALO = {"text-halo-color": "#ffffff", "text-halo-width": 1.2}
CONTOURS = sorted(CONTOUR_LINE_TYPES)


def _filter(t):
    return ["==", ["get", "t"], t]


def _polygon_layer(t, style, images):
    base = {"id": f"pg-{t}", "type": "fill", "source": "garmin", "source-layer": "polygons", "filter": _filter(t)}
    if style and style.pattern is not None:
        images[f"pg-{t}"] = style.pattern
        return {**base, "paint": {"fill-pattern": f"pg-{t}", "fill-antialias": False}}
    color = style.color if style else (None if t in SKIP_POLYGONS else POLYGON_COLORS.get(t))
    if color is None:
        return None
    return {**base, "paint": {"fill-color": color, "fill-antialias": False}}


def _line_style(t, style):
    if style:
        return style
    color, width, dash = LINE_STYLES.get(t, DEFAULT_LINE)
    return LineStyle(color, width, dash=dash)


def _line_layer(layer_id, t, color, width, dash):
    paint = {"line-color": color,
             "line-width": ["interpolate", ["linear"], ["zoom"], 8, max(0.5, width * 0.4), 14, max(1, width)]}
    if dash:
        paint["line-dasharray"] = dash
    return {"id": layer_id, "type": "line", "source": "garmin", "source-layer": "lines", "filter": _filter(t),
            "layout": {"line-join": "round", "line-cap": "butt" if dash else "round"}, "paint": paint}


def _label_layers():
    is_contour = ["in", ["get", "t"], ["literal", CONTOURS]]
    return [
        {"id": "pg-labels", "type": "symbol", "source": "garmin", "source-layer": "polygons",
         "filter": ["has", "name"],
         "layout": {"text-field": ["get", "name"], "text-font": [FONT_ITALIC], "text-size": 11, "text-max-width": 8},
         "paint": {"text-color": "#2c5a85", **HALO}},
        {"id": "contour-labels", "type": "symbol", "source": "garmin", "source-layer": "lines",
         "filter": ["all", ["has", "name"], is_contour],
         "layout": {"symbol-placement": "line", "text-field": ["get", "name"], "text-font": [FONT_REGULAR],
                    "text-size": 9},
         "paint": {"text-color": "#8a6a4a", **HALO}},
        {"id": "line-labels", "type": "symbol", "source": "garmin", "source-layer": "lines",
         "filter": ["all", ["has", "name"], ["!", is_contour]],
         "layout": {"symbol-placement": "line", "text-field": ["get", "name"], "text-font": [FONT_REGULAR],
                    "text-size": 11, "text-max-angle": 30},
         "paint": {"text-color": "#333333", **HALO}},
    ]


def _point_layers(icon_types):
    has_icon = ["in", ["get", "t"], ["literal", icon_types]]
    text = {"text-font": [FONT_REGULAR], "text-size": 10, "text-anchor": "top", "text-max-width": 8}
    return [
        {"id": "poi-dots", "type": "circle", "source": "garmin", "source-layer": "points",
         "filter": ["!", has_icon],
         "paint": {"circle-radius": 2.5, "circle-color": "#555555", "circle-stroke-color": "#ffffff",
                   "circle-stroke-width": 1}},
        {"id": "poi-dot-labels", "type": "symbol", "source": "garmin", "source-layer": "points",
         "filter": ["all", ["!", has_icon], ["has", "name"]],
         "layout": {"text-field": ["get", "name"], "text-offset": [0, 0.8], **text},
         "paint": {"text-color": "#222222", **HALO}},
        {"id": "poi-icons", "type": "symbol", "source": "garmin", "source-layer": "points", "filter": has_icon,
         "layout": {"icon-image": ["concat", "pt-", ["to-string", ["get", "t"]]],
                    "text-field": ["coalesce", ["get", "name"], ""], "text-offset": [0, 1.1],
                    "text-optional": True, **text},
         "paint": {"text-color": "#222222", **HALO}},
    ]


def build_style(typ, types):
    images = {}
    layers = [{"id": "background", "type": "background", "paint": {"background-color": BACKGROUND}}]
    polygon_types = sorted((int(t) for t in types.get("polygons", {})), key=lambda t: (typ.draw_level.get(t, 0), t))
    for t in polygon_types:
        layer = _polygon_layer(t, typ.polygons.get(t), images)
        if layer:
            layers.append(layer)
    layers.append({"id": "hillshade", "type": "hillshade", "source": "dem",
                   "paint": {"hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#5a4a3a",
                             "hillshade-accent-color": "#5a4a3a", "hillshade-highlight-color": "#ffffff"}})
    line_types = sorted((int(t) for t in types.get("lines", {})),
                        key=lambda t: (LINE_PRIORITY.get(t, DEFAULT_LINE_PRIORITY), t))
    line_styles = {t: _line_style(t, typ.lines.get(t)) for t in line_types}
    for t in line_types:
        s = line_styles[t]
        if s.border_color:
            layers.append(_line_layer(f"ln-{t}-casing", t, s.border_color, s.border_width, None))
    for t in line_types:
        s = line_styles[t]
        layers.append(_line_layer(f"ln-{t}", t, s.color, s.width, s.dash))
    layers += _label_layers()
    icon_types = [t for t in sorted(int(t) for t in types.get("points", {})) if t in typ.points]
    for t in icon_types:
        images[f"pt-{t}"] = typ.points[t].image
    layers += _point_layers(icon_types)
    style = {
        "version": 8,
        "name": "GPSmap.is",
        "sources": {
            "garmin": {"type": "vector", "tiles": ["mbtiles://vector/{z}/{x}/{y}"],
                       "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM},
            "dem": {"type": "raster-dem", "tiles": ["mbtiles://dem/{z}/{x}/{y}"], "tileSize": 256,
                    "minzoom": 5, "maxzoom": 11, "encoding": "mapbox"},
        },
        "glyphs": "fonts://{fontstack}/{range}.pbf",
        "sprite": "sprite://sprite",
        "layers": layers,
    }
    return style, images


def pack_sprite(images):
    width = 512
    x = y = row_h = 0
    index, placed = {}, []
    for name, img in sorted(images.items(), key=lambda kv: (-kv[1].height, kv[0])):
        w, h = img.size
        if x + w > width:
            x, y, row_h = 0, y + row_h + 1, 0
        placed.append((img, x, y))
        index[name] = {"x": x, "y": y, "width": w, "height": h, "pixelRatio": 1}
        x += w + 1
        row_h = max(row_h, h)
    sheet = Image.new("RGBA", (width, max(1, y + row_h)), (0, 0, 0, 0))
    for img, px, py in placed:
        sheet.paste(img, (px, py))
    return sheet, index


def write_style(out_dir, typ, types):
    style, images = build_style(typ, types)
    sheet, index = pack_sprite(images)
    (out_dir / "style.json").write_text(json.dumps(style, indent=1))
    sheet.save(out_dir / "sprite.png")
    (out_dir / "sprite.json").write_text(json.dumps(index, indent=1))
```

- [ ] **Step 6: Add the `style` CLI command**

In `imgconv/cli.py`, add these imports:
```python
import json

from .stylegen import write_style
from .typ import empty_typ, parse_typ
```
Add the handler:
```python
def cmd_style(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    types_path = out / "types.json"
    if not types_path.exists():
        raise ImgError(f"{types_path} missing; run `imgconv decode` first")
    typ_bytes = ImgContainer.from_path(args.img).first_of_type("TYP")
    typ = parse_typ(typ_bytes) if typ_bytes else empty_typ()
    write_style(out, typ, json.loads(types_path.read_text()))
    print(f"wrote {out / 'style.json'} and sprite")
```
Register it in `build_parser()` before `return p`:
```python
    s = sub.add_parser("style", help="TYP -> style.json + sprite")
    s.add_argument("img")
    s.add_argument("--out")
    s.set_defaults(func=cmd_style)
```

- [ ] **Step 7: Run tests and generate the real style**

Run:
```bash
.venv/bin/pytest -v
.venv/bin/imgconv style "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
python3 -c "import json; s=json.load(open('out/iceland-gpsmap-is-2024-21-detailed/style.json')); print(len(s['layers']), 'layers')"
```
Expected: all tests pass, and the style has a few dozen to ~150 layers.

- [ ] **Step 8: Commit**

```bash
git add imgconv/fallback_styles.py imgconv/stylegen.py imgconv/cli.py tests/test_stylegen.py assets/fonts
git commit -m "Generate MapLibre style and sprite from the TYP file"
```

---

### Task 9: Vector tiles (tippecanoe) and DEM tiles (GDAL)

**Files:**
- Create: `imgconv/mbtiles.py`, `imgconv/tiling.py`, `imgconv/hillshade.py`, `tests/test_mbtiles.py`
- Modify: `imgconv/cli.py` (add `tiles` and `dem` commands)

**Interfaces:**
- Consumes: `ImgError`, `cli.variant_dir`, `cli.HGT_DIR`, `cli.OUT`.
- Produces:
  - `mbtiles.write_from_xyz(tiles_dir: Path, out: Path, metadata: dict[str, str]) -> int`, which returns the tile count and flips y to TMS rows.
  - `tiling.build_vector_tiles(features: Path, out: Path) -> None`.
  - `hillshade.build_dem_mbtiles(hgt_dir: Path, out: Path, work: Path, maxzoom=11) -> None`.
  - `hillshade.decode_terrain_rgb(r, g, b) -> float`.
  - CLI `imgconv tiles IMG [--out DIR]` and `imgconv dem [--hgt DIR] [--out FILE]` (default `out/dem.mbtiles`).

- [ ] **Step 1: Install tools**

Run: `brew install tippecanoe gdal && tippecanoe --version && gdalinfo --version && (which gdal_calc.py || which gdal_calc) && (which gdal2tiles.py || which gdal2tiles)`
Expected: versions print, and both gdal_calc and gdal2tiles resolve under one of their names.

- [ ] **Step 2: Write the failing tests**

`tests/test_mbtiles.py`:
```python
import sqlite3

from imgconv.hillshade import decode_terrain_rgb
from imgconv.mbtiles import write_from_xyz


def test_write_from_xyz_flips_rows(tmp_path):
    (tmp_path / "xyz" / "3" / "2").mkdir(parents=True)
    (tmp_path / "xyz" / "3" / "2" / "1.png").write_bytes(b"PNG")
    out = tmp_path / "t.mbtiles"
    assert write_from_xyz(tmp_path / "xyz", out, {"name": "t", "format": "png"}) == 1
    db = sqlite3.connect(out)
    assert db.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles").fetchall() == [(3, 2, 6, b"PNG")]
    assert dict(db.execute("SELECT name, value FROM metadata")) == {"name": "t", "format": "png"}


def test_decode_terrain_rgb():
    assert decode_terrain_rgb(1, 134, 160) == 0.0
    assert round(decode_terrain_rgb(1, 217, 32), 1) == 2112.0
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_mbtiles.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement**

`imgconv/mbtiles.py`:
```python
import sqlite3


def create(path, metadata):
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);"
        "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,"
        " PRIMARY KEY (zoom_level, tile_column, tile_row));")
    db.executemany("INSERT INTO metadata VALUES (?, ?)", metadata.items())
    return db


def write_from_xyz(tiles_dir, out, metadata):
    db = create(out, metadata)
    count = 0
    for png in tiles_dir.glob("*/*/*.png"):
        z, x, y = int(png.parent.parent.name), int(png.parent.name), int(png.stem)
        db.execute("INSERT INTO tiles VALUES (?, ?, ?, ?)", (z, x, (1 << z) - 1 - y, png.read_bytes()))
        count += 1
    db.commit()
    db.close()
    return count
```

`imgconv/tiling.py`:
```python
import subprocess

from .features import MAX_ZOOM, MIN_ZOOM


def build_vector_tiles(features, out):
    subprocess.run([
        "tippecanoe", "-o", str(out), "--force", "-n", "GPSmap.is",
        f"-Z{MIN_ZOOM}", f"-z{MAX_ZOOM}", "-d", "13",
        "--no-feature-limit", "--no-tile-size-limit", "--no-tiny-polygon-reduction",
        "--read-parallel", "--quiet", str(features),
    ], check=True)
```

`imgconv/hillshade.py`:
```python
import os
import shutil
import subprocess

from .errors import ImgError
from .mbtiles import write_from_xyz


def decode_terrain_rgb(r, g, b):
    return -10000 + (r * 65536 + g * 256 + b) * 0.1


def _tool(*names):
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    raise ImgError(f"none of {names} found on PATH (brew install gdal)")


def _run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def build_dem_mbtiles(hgt_dir, out, work, maxzoom=11):
    hgts = sorted(hgt_dir.glob("*.hgt"))
    if not hgts:
        raise ImgError(f"no .hgt files in {hgt_dir}")
    work.mkdir(parents=True, exist_ok=True)
    vrt, merc, rgb, tiles = work / "dem.vrt", work / "dem3857.tif", work / "rgb.tif", work / "demtiles"
    _run("gdalbuildvrt", "-overwrite", vrt, *hgts)
    _run("gdalwarp", "-overwrite", "-t_srs", "EPSG:3857", "-r", "bilinear", "-srcnodata", "-32768",
         "-dstnodata", "None", "-ot", "Float32", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", vrt, merc)
    height = "(maximum(A,0)+10000)*10"
    _run(_tool("gdal_calc.py", "gdal_calc"), "--overwrite", "-A", merc, "--outfile", rgb, "--type", "Byte",
         "--hideNoData", f"--calc=floor({height}/65536)", f"--calc=floor({height}/256)%256",
         f"--calc=floor({height})%256")
    shutil.rmtree(tiles, ignore_errors=True)
    _run(_tool("gdal2tiles.py", "gdal2tiles"), "--xyz", "-r", "near", "-z", f"5-{maxzoom}", "-w", "none",
         f"--processes={os.cpu_count()}", rgb, tiles)
    count = write_from_xyz(tiles, out, {"name": "dem", "format": "png", "type": "overlay",
                                        "minzoom": "5", "maxzoom": str(maxzoom), "encoding": "mapbox"})
    print(f"wrote {count} DEM tiles to {out}")
```

- [ ] **Step 5: Add CLI commands**

In `imgconv/cli.py`, add these imports:
```python
from .hillshade import build_dem_mbtiles
from .tiling import build_vector_tiles
```
Add the handlers:
```python
def cmd_tiles(args):
    out = Path(args.out) if args.out else variant_dir(args.img)
    build_vector_tiles(out / "features.geojsonseq", out / "vector.mbtiles")
    print(f"wrote {out / 'vector.mbtiles'}")


def cmd_dem(args):
    out = Path(args.out)
    build_dem_mbtiles(Path(args.hgt), out, out.parent / "dem-work")
```
Register them:
```python
    s = sub.add_parser("tiles", help="features.geojsonseq -> vector.mbtiles (tippecanoe)")
    s.add_argument("img")
    s.add_argument("--out")
    s.set_defaults(func=cmd_tiles)
    s = sub.add_parser("dem", help=".hgt -> terrain-RGB dem.mbtiles (GDAL)")
    s.add_argument("--hgt", default=str(HGT_DIR))
    s.add_argument("--out", default=str(OUT / "dem.mbtiles"))
    s.set_defaults(func=cmd_dem)
```

- [ ] **Step 6: Run tests and both stages on real data**

Run:
```bash
.venv/bin/pytest -v
time .venv/bin/imgconv tiles "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
sqlite3 out/iceland-gpsmap-is-2024-21-detailed/vector.mbtiles "SELECT zoom_level, count(*) FROM tiles GROUP BY 1; SELECT value FROM metadata WHERE name='bounds';"
time .venv/bin/imgconv dem
.venv/bin/python - <<'EOF'
import sqlite3, io
from PIL import Image
from imgconv.hillshade import decode_terrain_rgb
db = sqlite3.connect("out/dem.mbtiles")
top = 0
for (data,) in db.execute("SELECT tile_data FROM tiles WHERE zoom_level = 9"):
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    top = max(top, max(decode_terrain_rgb(r, g, b) for r, g, b, a in img.getdata() if a))
print("max height", round(top))
EOF
```
Expected: all tests pass; vector tiles exist for zooms 4–14; bounds are roughly `-26,63,-12,67`; the DEM step writes thousands of tiles; the max height at z9 is between 1900 and 2300 m (Hvannadalshnúkur is ~2110 m).

- [ ] **Step 7: Commit**

```bash
git add imgconv/mbtiles.py imgconv/tiling.py imgconv/hillshade.py imgconv/cli.py tests/test_mbtiles.py
git commit -m "Build vector tiles with tippecanoe and terrain-RGB DEM with GDAL"
```

---

### Task 10: Node renderer and sample-tile visual check

**Files:**
- Create: `render/package.json`, `render/lib/tiles.mjs`, `render/lib/mbtiles.mjs`, `render/lib/renderer.mjs`, `render/worker.mjs`, `render/render.mjs`, `render/test/tiles.test.mjs`
- Modify: `imgconv/cli.py` (add `sample` command)

**Interfaces:**
- Consumes: `style.json`, `sprite.{png,json}`, `vector.mbtiles`, `out/dem.mbtiles`, `assets/fonts`.
- Produces:
  - `tiles.mjs`: `lonToTileX(lon, z)`, `latToTileY(lat, z)`, `tilePixelToLonLat(px, py, z)`, `metatiles(bounds, z, size) -> [{z, mx, my, size, tiles: [[x, y]]}]` and `metatileView(meta, bufferPx) -> {zoom, center, width, height}`.
  - `mbtiles.mjs`: `openReader(path) -> {get(z, x, y), metadata(), close()}` and `openWriter(path, metadata) -> {isDone(z, mx, my), writeMetatile(meta, tiles), finish(), close()}`.
  - `renderer.mjs`: `createMap({style, vector, dem, sprite, fonts}) -> {render(view) -> Promise<Buffer RGBA>, release()}`.
  - CLI `node render/render.mjs sample --style … --vector … --dem … --sprite DIR --fonts DIR --center lon,lat --zoom Z --size N --out file.png`.
  - Python `imgconv sample IMG --center lon,lat --zoom Z [--size 1024] [--name NAME]` writes `out/<variant>/samples/<name>.png`.
- Zoom convention: raster zoom Z renders at MapLibre zoom Z−1.

- [ ] **Step 1: Set up the package**

```bash
mkdir -p render/lib render/test && cd render
npm init -y >/dev/null
npm pkg set type=module private=true scripts.test="node --test test/"
npm install @maplibre/maplibre-gl-native better-sqlite3 sharp
npm install --save-dev @maplibre/maplibre-gl-style-spec
cd ..
```

- [ ] **Step 2: Write the failing tile-math tests**

`render/test/tiles.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { lonToTileX, latToTileY, tilePixelToLonLat, metatiles, metatileView } from '../lib/tiles.mjs';

test('tile indices at low zoom', () => {
  assert.equal(lonToTileX(-180, 0), 0);
  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.equal(latToTileY(60, 1), 0);
});

test('tile corner round-trips', () => {
  const z = 15, x = 14387, y = 7890;
  const [lon, lat] = tilePixelToLonLat(x * 256 + 1, y * 256 + 1, z);
  assert.equal(lonToTileX(lon, z), x);
  assert.equal(latToTileY(lat, z), y);
});

test('metatiles cover the bounds exactly once', () => {
  const metas = metatiles([-22, 64, -21.5, 64.2], 12, 8);
  const all = metas.flatMap((m) => m.tiles.map(([x, y]) => `${x}/${y}`));
  assert.equal(new Set(all).size, all.length);
  const x0 = lonToTileX(-22, 12), x1 = lonToTileX(-21.5, 12);
  const y0 = latToTileY(64.2, 12), y1 = latToTileY(64, 12);
  assert.equal(all.length, (x1 - x0 + 1) * (y1 - y0 + 1));
});

test('metatile view renders one zoom lower with a buffer', () => {
  const view = metatileView({ z: 10, mx: 0, my: 0, size: 8, tiles: [] }, 256);
  assert.equal(view.zoom, 9);
  assert.equal(view.width, 8 * 256 + 512);
  const [lon] = tilePixelToLonLat(4 * 256, 4 * 256, 10);
  assert.equal(view.center[0], lon);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd render && npm test; cd ..`
Expected: FAIL (cannot find `../lib/tiles.mjs`).

- [ ] **Step 4: Implement the tile math**

`render/lib/tiles.mjs`:
```js
export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

// px, py are pixel coordinates in the 256-px tile world at zoom z
export function tilePixelToLonLat(px, py, z) {
  const n = 256 * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export function metatiles(bounds, z, size) {
  const [w, s, e, n] = bounds;
  const x0 = lonToTileX(w, z), x1 = lonToTileX(e, z);
  const y0 = latToTileY(n, z), y1 = latToTileY(s, z);
  const out = [];
  for (let my = Math.floor(y0 / size); my <= Math.floor(y1 / size); my++) {
    for (let mx = Math.floor(x0 / size); mx <= Math.floor(x1 / size); mx++) {
      const tiles = [];
      for (let y = Math.max(my * size, y0); y <= Math.min(my * size + size - 1, y1); y++) {
        for (let x = Math.max(mx * size, x0); x <= Math.min(mx * size + size - 1, x1); x++) tiles.push([x, y]);
      }
      out.push({ z, mx, my, size, tiles });
    }
  }
  return out;
}

// Raster zoom z is rendered at MapLibre zoom z - 1 (MapLibre's world is 512 px wide at zoom 0).
export function metatileView(meta, bufferPx) {
  const { z, mx, my, size } = meta;
  const center = tilePixelToLonLat((mx * size + size / 2) * 256, (my * size + size / 2) * 256, z);
  const px = size * 256 + 2 * bufferPx;
  return { zoom: z - 1, center, width: px, height: px };
}
```

Run: `cd render && npm test; cd ..`
Expected: 4 tests pass.

- [ ] **Step 5: Implement the MBTiles access and renderer**

`render/lib/mbtiles.mjs`:
```js
import Database from 'better-sqlite3';

export function openReader(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const tile = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
  return {
    get(z, x, y) {
      const row = tile.get(z, x, 2 ** z - 1 - y);
      return row ? row.tile_data : null;
    },
    metadata() {
      return Object.fromEntries(db.prepare('SELECT name, value FROM metadata').all().map((r) => [r.name, r.value]));
    },
    close() { db.close(); },
  };
}

export function openWriter(path, metadata) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 60000');
  db.exec(`CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row));
    CREATE TABLE IF NOT EXISTS render_done (z INTEGER, mx INTEGER, my INTEGER, PRIMARY KEY (z, mx, my));`);
  if (metadata) {
    const put = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
    for (const [k, v] of Object.entries(metadata)) put.run(k, String(v));
  }
  const done = db.prepare('SELECT 1 FROM render_done WHERE z = ? AND mx = ? AND my = ?');
  const putTile = db.prepare('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)');
  const markDone = db.prepare('INSERT OR REPLACE INTO render_done VALUES (?, ?, ?)');
  const writeMetatile = db.transaction((meta, tiles) => {
    for (const { x, y, data } of tiles) putTile.run(meta.z, x, 2 ** meta.z - 1 - y, data);
    markDone.run(meta.z, meta.mx, meta.my);
  });
  return {
    isDone: (z, mx, my) => Boolean(done.get(z, mx, my)),
    writeMetatile,
    finish() { db.exec('DROP TABLE IF EXISTS render_done'); db.pragma('wal_checkpoint(TRUNCATE)'); },
    close() { db.close(); },
  };
}
```

`render/lib/renderer.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import mbgl from '@maplibre/maplibre-gl-native';
import { openReader } from './mbtiles.mjs';

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function createMap({ style, vector, dem, sprite, fonts }) {
  const readers = { vector: openReader(vector), dem: openReader(dem) };
  const map = new mbgl.Map({
    ratio: 1,
    request(req, callback) {
      try {
        const url = req.url;
        let data = null;
        if (url.startsWith('mbtiles://')) {
          const [source, z, x, y] = url.slice('mbtiles://'.length).split('/');
          data = readers[source].get(Number(z), Number(x), Number(y));
          if (data && data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
        } else if (url.startsWith('fonts://')) {
          const rest = decodeURIComponent(url.slice('fonts://'.length));
          const slash = rest.lastIndexOf('/');
          const stack = rest.slice(0, slash).split(',')[0].trim();
          data = readIfExists(path.join(fonts, stack, rest.slice(slash + 1)));
        } else if (url.startsWith('sprite://')) {
          data = readIfExists(path.join(sprite, path.basename(url.slice('sprite://'.length))));
        }
        if (data) callback(null, { data });
        else callback();
      } catch (err) {
        callback(err);
      }
    },
  });
  map.load(typeof style === 'string' ? JSON.parse(fs.readFileSync(style, 'utf8')) : style);
  return {
    render(view) {
      return new Promise((resolve, reject) => {
        map.render(view, (err, buffer) => (err ? reject(err) : resolve(buffer)));
      });
    },
    release() {
      map.release();
      readers.vector.close();
      readers.dem.close();
    },
  };
}
```

- [ ] **Step 6: Implement the worker and CLI (`sample` + `tiles`)**

`render/worker.mjs`:
```js
import sharp from 'sharp';
import { createMap } from './lib/renderer.mjs';
import { metatileView } from './lib/tiles.mjs';
import { openWriter } from './lib/mbtiles.mjs';

const cfg = JSON.parse(process.argv[2]);
const renderer = createMap(cfg);
const out = openWriter(cfg.out);

function encode(img, format) {
  return format === 'jpg' ? img.jpeg({ quality: 85, mozjpeg: true }) : img.png({ palette: true, effort: 4 });
}

process.on('message', async (meta) => {
  try {
    const view = metatileView(meta, cfg.buffer);
    const raw = await renderer.render(view);
    const image = sharp(raw, { raw: { width: view.width, height: view.height, channels: 4 } });
    const tiles = [];
    for (const [x, y] of meta.tiles) {
      const left = cfg.buffer + (x - meta.mx * meta.size) * 256;
      const top = cfg.buffer + (y - meta.my * meta.size) * 256;
      const data = await encode(image.clone().extract({ left, top, width: 256, height: 256 }), cfg.format).toBuffer();
      tiles.push({ x, y, data });
    }
    out.writeMetatile(meta, tiles);
    process.send({ ok: true, n: tiles.length });
  } catch (err) {
    process.send({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
});
```

`render/render.mjs`:
```js
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { createMap } from './lib/renderer.mjs';
import { metatiles } from './lib/tiles.mjs';
import { openReader, openWriter } from './lib/mbtiles.mjs';

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string' }, vector: { type: 'string' }, dem: { type: 'string' },
    sprite: { type: 'string' }, fonts: { type: 'string' }, out: { type: 'string' },
    minzoom: { type: 'string', default: '5' }, maxzoom: { type: 'string', default: '15' },
    workers: { type: 'string', default: String(Math.max(1, os.cpus().length - 2)) },
    metatile: { type: 'string', default: '8' }, buffer: { type: 'string', default: '256' },
    format: { type: 'string', default: 'png' },
    center: { type: 'string' }, zoom: { type: 'string' }, size: { type: 'string', default: '1024' },
  },
});

const sources = { style: opts.style, vector: opts.vector, dem: opts.dem, sprite: opts.sprite, fonts: opts.fonts };

async function sample() {
  const [lon, lat] = opts.center.split(',').map(Number);
  const size = Number(opts.size);
  const map = createMap(sources);
  const view = { zoom: Number(opts.zoom) - 1, center: [lon, lat], width: size, height: size };
  const raw = await map.render(view);
  await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toFile(opts.out);
  map.release();
  console.log(`wrote ${opts.out}`);
}

async function tiles() {
  const bounds = openReader(opts.vector).metadata().bounds.split(',').map(Number);
  const minzoom = Number(opts.minzoom), maxzoom = Number(opts.maxzoom), size = Number(opts.metatile);
  const writer = openWriter(opts.out, {
    name: 'GPSmap.is', type: 'baselayer', version: '1', format: opts.format, attribution: 'GPSmap.is',
    description: 'Rendered from Garmin IMG', bounds: bounds.join(','), minzoom, maxzoom,
    center: `${(bounds[0] + bounds[2]) / 2},${(bounds[1] + bounds[3]) / 2},8`,
  });
  const jobs = [];
  for (let z = minzoom; z <= maxzoom; z++) {
    for (const meta of metatiles(bounds, z, size)) if (!writer.isDone(z, meta.mx, meta.my)) jobs.push(meta);
  }
  const total = jobs.length;
  console.log(`${total} metatiles to render (z${minzoom}-${maxzoom}, bounds ${bounds.join(',')})`);
  const cfg = JSON.stringify({ ...sources, out: opts.out, buffer: Number(opts.buffer), format: opts.format });
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  let done = 0, tilesDone = 0, lastLog = 0;
  const t0 = Date.now();
  const progress = () => {
    const now = Date.now();
    if (now - lastLog < 10000 && done !== total) return;
    lastLog = now;
    const rate = done / ((now - t0) / 1000);
    const eta = rate ? Math.round((total - done) / rate / 60) : '?';
    console.log(`${done}/${total} metatiles, ${tilesDone} tiles, ${rate.toFixed(1)} meta/s, ETA ${eta} min`);
  };
  await Promise.all(Array.from({ length: Math.min(Number(opts.workers), total) }, () => new Promise((resolve, reject) => {
    const worker = fork(workerPath, [cfg]);
    const next = () => {
      const job = jobs.shift();
      if (!job) { worker.kill(); resolve(); return; }
      worker.send(job);
    };
    worker.on('message', (msg) => {
      if (!msg.ok) { worker.kill(); reject(new Error(msg.error)); return; }
      done += 1;
      tilesDone += msg.n;
      progress();
      next();
    });
    worker.on('exit', (code) => { if (code && jobs.length) reject(new Error(`worker exited with ${code}`)); });
    next();
  })));
  writer.finish();
  writer.close();
  console.log(`done: ${tilesDone} tiles written to ${opts.out}`);
}

const command = positionals[0];
const run = command === 'sample' ? sample : command === 'tiles' ? tiles : null;
if (!run) {
  console.error('usage: render.mjs sample|tiles --style … --vector … --dem … --sprite DIR --fonts DIR --out …');
  process.exit(2);
}
run().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 7: Add the Python `sample` command**

In `imgconv/cli.py`, add `import subprocess` and the constant `RENDERER = REPO / "render" / "render.mjs"`. Then add:
```python
def render_args(out_dir):
    return ["--style", out_dir / "style.json", "--vector", out_dir / "vector.mbtiles",
            "--dem", OUT / "dem.mbtiles", "--sprite", out_dir, "--fonts", FONTS]


def cmd_sample(args):
    out = variant_dir(args.img)
    (out / "samples").mkdir(exist_ok=True)
    target = out / "samples" / f"{args.name or f'z{args.zoom}'}.png"
    # "=" form: node's parseArgs rejects option values that start with "-" (western longitudes)
    subprocess.run(["node", RENDERER, "sample", *render_args(out), f"--center={args.center}",
                    "--zoom", str(args.zoom), "--size", str(args.size), "--out", target], check=True)
```
Register it:
```python
    s = sub.add_parser("sample", help="render one image for visual checking")
    s.add_argument("img")
    s.add_argument("--center", required=True, help="lon,lat")
    s.add_argument("--zoom", type=int, required=True, help="raster zoom (5-15)")
    s.add_argument("--size", type=int, default=1024)
    s.add_argument("--name")
    s.set_defaults(func=cmd_sample)
```
`subprocess.run` accepts `Path` objects in the argument list, so no `str()` conversion is needed.

- [ ] **Step 8: Validate the style and render samples**

Run:
```bash
(cd render && npm test && npx gl-style-validate ../out/iceland-gpsmap-is-2024-21-detailed/style.json)
IMG="GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
.venv/bin/imgconv sample "$IMG" --center=-21.94,64.146 --zoom 15 --name reykjavik-z15
.venv/bin/imgconv sample "$IMG" --center=-19.06,63.99 --zoom 13 --name landmannalaugar-z13
.venv/bin/imgconv sample "$IMG" --center=-18.6,64.9 --zoom 7 --name iceland-z7
.venv/bin/imgconv sample "$IMG" --center=-16.9,64.02 --zoom 11 --name vatnajokull-z11
```
Expected: the tile-math tests pass, the style validator prints no errors (fix any it reports in `stylegen.py`), and four PNGs appear under `out/iceland-gpsmap-is-2024-21-detailed/samples/`.

Open each PNG with the Read tool and check the following:

- Coastline, lakes and glaciers are filled.
- Roads and trails are visible.
- Hillshade shows relief.
- Labels render with Icelandic characters.
- At z7 there is enough content without clutter.
- At z15 the detailed (24-bit) data is present.

Tune only these knobs: `ZOOM_OFFSET` in `features.py` (requires re-running decode and tiles), and widths, colours and hillshade paint in `stylegen.py` and `fallback_styles.py`.

- [ ] **Step 9: Commit, then STOP for user review**

```bash
git add render imgconv/cli.py
git commit -m "Add headless MapLibre renderer and sample command"
```

Show the user the four sample images and suggest they compare them with QMapShack (`brew install --cask qmapshack`, then open the same IMG). **Do not start Task 11 until the user approves the look.**

---

### Task 11: Full render, `convert` command and README

**Files:**
- Modify: `imgconv/cli.py` (add `render` and `convert`)
- Create: `README.md`

**Interfaces:**
- Consumes: every previous stage.
- Produces: CLI `imgconv render IMG [--workers N] [--format png|jpg] [--maxzoom 15]` and `imgconv convert IMG [--hgt DIR]`, which runs decode → style → tiles → dem (skipped if `out/dem.mbtiles` exists) → render. The final output is `out/<variant>/<variant>.mbtiles`.

- [ ] **Step 1: Add the commands**

In `imgconv/cli.py`:
```python
def cmd_render(args):
    out = variant_dir(args.img)
    target = out / f"{out.name}.mbtiles"
    extra = ["--format", args.format, "--maxzoom", str(args.maxzoom)]
    if args.workers:
        extra += ["--workers", str(args.workers)]
    subprocess.run(["node", RENDERER, "tiles", *render_args(out), "--out", target, *extra], check=True)
    print(f"finished: {target}")


def cmd_convert(args):
    out = variant_dir(args.img)
    cmd_decode(argparse.Namespace(img=args.img, out=str(out), workers=os.cpu_count()))
    cmd_style(argparse.Namespace(img=args.img, out=str(out)))
    cmd_tiles(argparse.Namespace(img=args.img, out=str(out)))
    if not (OUT / "dem.mbtiles").exists():
        cmd_dem(argparse.Namespace(hgt=args.hgt, out=str(OUT / "dem.mbtiles")))
    cmd_render(args)
```
Register both:
```python
    for name, func, help_text in (("render", cmd_render, "render raster MBTiles (resumable)"),
                                  ("convert", cmd_convert, "run every stage for one IMG")):
        s = sub.add_parser(name, help=help_text)
        s.add_argument("img")
        s.add_argument("--workers", type=int)
        s.add_argument("--format", choices=["png", "jpg"], default="png")
        s.add_argument("--maxzoom", type=int, default=15)
        s.add_argument("--hgt", default=str(HGT_DIR))
        s.set_defaults(func=func)
```

- [ ] **Step 2: Write the README**

`README.md`:
````markdown
# GPSmap.is → MBTiles

Converts the GPSmap.is Garmin IMG maps (made for OruxMaps on Android) into raster MBTiles with hillshade,
for offline use in iOS map apps that open MBTiles (for example Guru Maps).

## Setup

```bash
brew install tippecanoe gdal
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
(cd render && npm install)
```

## Convert a map

```bash
.venv/bin/imgconv convert "GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
```

The result is `out/<variant>/<variant>.mbtiles` (raster zooms 5–15). AirDrop it to the iPhone and open it with
the map app. Rendering is resumable: re-running `imgconv render` continues where it stopped.

Individual stages: `inspect`, `decode`, `style`, `tiles`, `dem`, `sample`, `render` (`imgconv --help`).

## Tests

```bash
.venv/bin/pytest            # tests marked realdata use the GPSmap.is files when present
(cd render && npm test)
```
````

- [ ] **Step 3: Run a small render first**

Run:
```bash
IMG="GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img"
time .venv/bin/imgconv render "$IMG" --maxzoom 10
sqlite3 out/iceland-gpsmap-is-2024-21-detailed/iceland-gpsmap-is-2024-21-detailed.mbtiles \
  "SELECT zoom_level, count(*), sum(length(tile_data))/1024/1024 AS mb FROM tiles GROUP BY 1;"
```
Expected: tiles for z5–10 with per-zoom counts and sizes. Use the metatiles/s rate from the log to estimate the full z15 run, and report the estimate to the user.

- [ ] **Step 4: Run the full render**

Run it in the background, because it takes hours:
```bash
.venv/bin/imgconv render "$IMG" > out/render-detailed.log 2>&1
```
Monitor `out/render-detailed.log`. When it finishes, check:
```bash
sqlite3 out/iceland-gpsmap-is-2024-21-detailed/iceland-gpsmap-is-2024-21-detailed.mbtiles \
  "SELECT zoom_level, count(*) FROM tiles GROUP BY 1; SELECT name, value FROM metadata;"
ls -lh out/iceland-gpsmap-is-2024-21-detailed/*.mbtiles
```
Expected: zooms 5–15 are all present, the metadata has format/bounds/minzoom/maxzoom, and the file is several GB.

- [ ] **Step 5: Commit**

```bash
git add imgconv/cli.py README.md
git commit -m "Add render and convert commands and README"
```

Tell the user where the file is and how to load it: AirDrop to the iPhone → open in Guru Maps, which imports MBTiles. Report the final file size and render time.

---

## Deviations from the spec

- **Zoom handling:** the spec said each object is emitted "at the most detailed level it appears in". The plan instead emits every level's objects in its own zoom band, so coarse levels provide generalized geometry at low zoom, which is what Garmin devices do. It also uses MapLibre zoom (raster zoom − 1) inside the vector pipeline, so phase 2's app can use the tiles unchanged.
- **Hillshade:** it is built as terrain-RGB DEM tiles rendered with MapLibre's `hillshade` layer, rather than `gdaldem hillshade` rasters. This is the same GDAL toolchain, and the DEM is reusable in phase 2.
- **Tile counts:** the spec estimated "3–4M tiles"; the real count for the Iceland bounds is about 1.4M (z5–15). The render uses 8×8 metatiles, about 22k renders.
