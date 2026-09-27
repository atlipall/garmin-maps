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
