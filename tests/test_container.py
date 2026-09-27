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


def test_rejects_duplicate_parts():
    """Verify that duplicate or missing FAT part numbers raise ImgError."""
    data = bytes(range(256)) * 20  # 5120 bytes = 10 blocks of 512
    raw = bytearray(build_img({"A.RGN": data}, blocks_per_entry=3))
    # Corrupt the second FAT entry (at 0x600) to have part number 0 (same as first)
    raw[0x600 + 0x10] = 0x00
    raw[0x600 + 0x11] = 0x00
    with pytest.raises(ImgError, match="FAT parts .* are not contiguous"):
        ImgContainer.from_bytes(bytes(raw))


def test_handles_out_of_order_parts():
    """Verify that FAT entries out of order are assembled in correct part order."""
    data = bytes(range(256)) * 20  # 5120 bytes = 10 blocks of 512
    raw = bytearray(build_img({"A.RGN": data}, blocks_per_entry=3))
    # Swap the second and third FAT entries for the same file
    raw[0x400:0x400 + 512], raw[0x600:0x600 + 512] = raw[0x600:0x600 + 512], raw[0x400:0x400 + 512]
    img = ImgContainer.from_bytes(bytes(raw))
    # Data should still be correctly assembled despite out-of-order FAT entries
    assert img.get("A.RGN") == data


@pytest.mark.realdata
def test_real_detailed_img(detailed_img):
    assert detailed_img.tile_ids() == ["14057401", "14057402", "14057403", "14057405", "14057406"]
    assert len(detailed_img.get("14057403.RGN")) == 17504055
    assert detailed_img.first_of_type("TYP")[2:12] == b"GARMIN TYP"
