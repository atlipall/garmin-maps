import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { Dem } from '../src/dem/dem';
import { decodeHgt, decodeTerrainRgb, encodeTerrainRgb, HGT_BYTES, HGT_SIZE, parseHgtName } from '../src/dem/hgt';
import { decodeOverview, encodeOverview, MAX_OVERVIEW_TILES, OverviewBuilder } from '../src/dem/overview';
import { BlobSource } from '../src/img/source';
import { latToTileY, lonToTileX } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { REPO } from './helpers/paths';

const HGT_DIR = REPO + 'GPSmap.is 2024.21 Android/HILLSHADE - Add content to DEM folder/';
const PY_DEM = REPO + 'out/dem.mbtiles';

/** A synthetic tile whose height is a function of (row, col) inside the file. */
function makeHgt(f: (r: number, c: number) => number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(HGT_BYTES);
  const dv = new DataView(b.buffer);
  for (let r = 0; r < HGT_SIZE; r++) for (let c = 0; c < HGT_SIZE; c++) dv.setInt16((r * HGT_SIZE + c) * 2, f(r, c), false);
  return b;
}

const heightsOf = (rgba: Uint8ClampedArray | Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i < rgba.length; i += 4) out.push(decodeTerrainRgb(rgba[i], rgba[i + 1], rgba[i + 2]));
  return out;
};

describe('hgt basics', () => {
  test('names', () => {
    expect(parseHgtName('n63w019.hgt')).toEqual({ south: 63, west: -19 });
    expect(parseHgtName('S12E005.HGT')).toEqual({ south: -12, west: 5 });
    expect(parseHgtName('dem/n66w025.hgt')).toEqual({ south: 66, west: -25 });
    expect(parseHgtName('readme.txt')).toBeNull();
  });

  test('decode clips voids and negatives', () => {
    const d = decodeHgt(new Uint8Array([0x00, 0x10, 0xff, 0xff, 0x80, 0x00, 0x07, 0xd0]));
    expect([...d]).toEqual([16, 0, 0, 2000]);
  });

  test('terrain-RGB round trip', () => {
    const px = new Uint8ClampedArray(4);
    encodeTerrainRgb(2112, px, 0);
    expect([...px]).toEqual([1, 217, 32, 255]);
    expect(decodeTerrainRgb(1, 217, 32)).toBeCloseTo(2112, 6);
    encodeTerrainRgb(-50, px, 0);
    expect(decodeTerrainRgb(px[0], px[1], px[2])).toBeCloseTo(0, 6);
  });
});

describe('Dem on synthetic tiles', () => {
  // two stacked tiles: n64w020 (north) above n63w020 (south); height = 1000 + mosaic row
  const north = makeHgt((r) => 1000 + r);
  const south = makeHgt((r) => 1000 + 1200 + r);
  const files = [
    { name: 'n64w020.hgt', src: new BlobSource(new Blob([north])) },
    { name: 'n63w020.hgt', src: new BlobSource(new Blob([south])) },
  ];

  test('bounds and orientation (north is up, heights grow southward)', async () => {
    const dem = Dem.fromFiles(files, null);
    expect(dem.bounds).toEqual([-20, 63, -19, 65]);
    const z = 11;
    const t = await dem.tile(z, lonToTileX(-19.5, z), latToTileY(64.5, z));
    const h = heightsOf(t);
    expect(h[0]).toBeLessThan(h[255 * 256]); // top row is north → smaller row → lower height
    for (const v of h) expect(v).toBeGreaterThan(1000);
  });

  test('outside the mosaic is zero', async () => {
    const dem = Dem.fromFiles(files, null);
    const t = await dem.tile(11, lonToTileX(-10, 11), latToTileY(64.5, 11));
    expect(Math.max(...heightsOf(t))).toBe(0);
  });

  test('overview matches full resolution closely at low zoom', async () => {
    const b = new OverviewBuilder([{ south: 64, west: -20 }, { south: 63, west: -20 }]);
    b.add(64, -20, decodeHgt(north));
    b.add(63, -20, decodeHgt(south));
    const ov = decodeOverview(encodeOverview(b.finish()));
    expect([ov.step, ov.rows, ov.cols]).toEqual([8, 301, 151]);
    const full = Dem.fromFiles(files, null);
    const coarse = Dem.fromFiles(files, ov);
    const [x, y] = [lonToTileX(-19.5, 8), latToTileY(64, 8)];
    const a = heightsOf(await full.tile(8, x, y));
    const c = heightsOf(await coarse.tile(8, x, y));
    let maxDiff = 0;
    a.forEach((v, i) => (maxDiff = Math.max(maxDiff, Math.abs(v - c[i]))));
    expect(maxDiff).toBeLessThan(1.0); // linear field: bilinear on the coarse grid is near-exact
  });

  test('overview rejects an elevation extent that would blow up the mosaic', () => {
    // Two far-apart tiles: 20° × 21° bounding box = 420 tiles > 400.
    expect(() => new OverviewBuilder([{ south: 50, west: -30 }, { south: 69, west: -10 }])).toThrow(/20° of latitude × 21° of longitude.*at most 400/);
    // Exactly at the cap is fine (20 × 20).
    expect(() => new OverviewBuilder([{ south: 50, west: -30 }, { south: 69, west: -11 }])).not.toThrow();
    expect(MAX_OVERVIEW_TILES).toBe(400);
  });

  test('rejects bad files', () => {
    expect(() => Dem.fromFiles([{ name: 'foo.hgt', src: new BlobSource(new Blob([north])) }], null)).toThrow(/foo\.hgt/);
    expect(() => Dem.fromFiles([{ name: 'n63w020.hgt', src: new BlobSource(new Blob([new Uint8Array(10)])) }], null)).toThrow(/1201/);
  });
});

const hasRealDem = existsSync(HGT_DIR) && existsSync(PY_DEM);

describe.skipIf(!hasRealDem)('Dem vs Python dem.mbtiles (golden)', () => {
  test('full-resolution tiles match within 0.2 m', async () => {
    const names = readdirSync(HGT_DIR).filter((n) => n.endsWith('.hgt'));
    expect(names.length).toBe(48);
    const files = await Promise.all(names.map(async (name) => ({ name, src: await nodeSource(HGT_DIR + name) })));
    const dem = Dem.fromFiles(files, null);
    const db = new DatabaseSync(PY_DEM, { readOnly: true });
    const get = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
    const places: Array<[string, number, number, number]> = [
      ['Hvannadalshnúkur z11', -16.676, 64.014, 11],
      ['Reykjavík z11', -21.94, 64.146, 11],
      ['Landmannalaugar z9', -19.06, 63.99, 9],
      ['Vatnajökull z8', -16.9, 64.4, 8],
    ];
    for (const [label, lon, lat, z] of places) {
      const [x, y] = [lonToTileX(lon, z), latToTileY(lat, z)];
      const row = get.get(z, x, (1 << z) - 1 - y) as { tile_data: Uint8Array } | undefined;
      expect(row, label).toBeDefined();
      const py = heightsOf(PNG.sync.read(Buffer.from(row!.tile_data)).data);
      const ours = heightsOf(await dem.tile(z, x, y));
      let maxDiff = 0;
      ours.forEach((v, i) => (maxDiff = Math.max(maxDiff, Math.abs(v - py[i]))));
      expect(maxDiff, label).toBeLessThanOrEqual(0.2);
    }
    const peak = heightsOf(await dem.tile(11, lonToTileX(-16.676, 11), latToTileY(64.014, 11)));
    expect(Math.max(...peak)).toBeGreaterThan(1900);
    db.close();
    await Promise.all(files.map((f) => (f.src as unknown as { close(): Promise<void> }).close()));
  }, 120_000);
});
