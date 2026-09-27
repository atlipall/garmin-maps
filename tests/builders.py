import struct


def pack_s24(v):
    return (v & 0xFFFFFF).to_bytes(3, "little")


def make_rgn_header(data_len, ext=((0, 0), (0, 0), (0, 0)), hlen=0x7D):
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN RGN"
    struct.pack_into("<II", h, 0x15, hlen, data_len)
    for (o, n), at in zip(ext, (0x1D, 0x39, 0x55)):
        struct.pack_into("<II", h, at, o, n)
    return h


def make_tre(levels, subdivs, ext_records=None, hlen=0xBC, bounds=(1000, 1000, -1000, -1000)):
    """levels: [(number, bits, inherited, count)]; subdivs: [(rgn_offset, kinds, cx, cy)] in level order;
    ext_records: [(poly2, line2, point2)] offsets (one per subdivision + sentinel)."""
    h = bytearray(hlen)
    struct.pack_into("<H", h, 0, hlen)
    h[2:12] = b"GARMIN TRE"
    n, e, s, w = bounds
    h[0x15:0x18], h[0x18:0x1B], h[0x1B:0x1E], h[0x1E:0x21] = pack_s24(n), pack_s24(e), pack_s24(s), pack_s24(w)
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
