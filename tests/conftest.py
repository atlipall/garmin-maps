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
