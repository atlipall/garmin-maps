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
