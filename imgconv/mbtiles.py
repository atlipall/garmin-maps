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
