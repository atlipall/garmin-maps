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
