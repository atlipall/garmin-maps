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
