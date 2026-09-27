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
