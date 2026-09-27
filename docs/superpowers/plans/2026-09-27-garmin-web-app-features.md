# Garmin Web App — Plan 2: Hillshade, Search, GPS, Offline Install, Deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plan 1 on-the-fly viewer into the app described in the spec, usable in the field on an iPhone:
- hillshade computed on the fly from the SRTM `.hgt` files;
- place-name search;
- GPS position with follow mode;
- a first-run import screen, with files kept in on-device storage (OPFS);
- installable and offline-capable (PWA);
- deployed to GitHub Pages.

**Architecture:**
- **Elevation (`dem/`).** Builds terrain-RGB tiles on demand from the HGT files. It uses the same maths as `imgconv/hillshade.py`, verified against its `out/dem.mbtiles`. A small overview grid, built once at import, serves low zooms. Tiles go to MapLibre as `ImageBitmap`s through `addProtocol('dem')`.
- **Search (`search/`).** Builds a place list in a worker from the finest map level, normalises Icelandic letters (þ→th, ð→d, æ→ae, and diacritics dropped), and caches the list in OPFS.
- **Storage (`storage/`).** Copies the IMG and the HGT files into OPFS from a worker, using sync access handles, and validates the IMG first so failures are loud.
- **App shell.** On startup the app opens from storage, or shows the import screen.
- **Offline.** A hand-written service worker caches the app shell and the fonts.
- **Deployment.** A GitHub Actions workflow deploys `web/dist` to Pages.

**Tech Stack:** Plan 1's stack (TypeScript, Vite 8, Vitest 5, MapLibre GL JS 6), plus OPFS, a Service Worker, MapLibre `GeolocateControl`, and `pngjs` with `node:sqlite` for the DEM golden test.

**Spec:** `docs/superpowers/specs/2026-09-27-garmin-web-app-design.md`
**Builds on:** `docs/superpowers/plans/2026-09-27-garmin-web-app-core.md` (Plan 1). Plan 1 must be complete, including its Task 11 fix round (worker respawn and error handling in `pool.ts`, and the POI image fix) and Task 11b (the page cache).

## Global Constraints

- All app code lives in `web/`. The branch is `web-app`. Never commit anything under `out/`, `web/node_modules/`, `web/public/fonts/` or `web/dist/`, and never commit the GPSmap.is data.
- Keep everything that is already verified:
  - Plan 1's decoder, tile builder and golden tests must keep passing unchanged: `cd web && npx vitest run`.
  - `npx tsc --noEmit` must stay clean.
- **Terrain-RGB maths:** it must match `imgconv/hillshade.py` exactly.
  - The mosaic is laid out from the HGT file names, with row 0 at the north edge and adjacent tiles sharing their edge. Voids and negative heights become 0.
  - Pixel centres are `(px + 0.5)/256`. Sampling is bilinear with clamped indices, and any point outside the mosaic bounds is 0.
  - Encoding is `v = round_half_even((max(h,0)+10000)*10)`, with R, G, B = `v/65536 % 256`, `v/256 % 256` and `v % 256`.
  - Tiles are z5–11 at 256 px. Zooms ≤ 8 are served from a step-8 overview grid instead of full resolution (a deliberate, documented deviation).
- The whole IMG and the whole DEM are never held in memory. Full-resolution DEM tiles read one row-band slice per HGT file.
- **Storage** lives in the OPFS directory `garmin/`, with these files:
  - `map.img`;
  - `dem/<name>.hgt`;
  - `dem-overview.bin`;
  - `places.json`;
  - `meta.json`, written LAST as the commit marker.

  Writes go through `createSyncAccessHandle` in a dedicated worker, because Safari lacks `createWritable` on older iOS.
- **Errors are loud.** An IMG that fails `GarminMap.open`, or HGT files with bad names or sizes, block the import with a message that names the file.
- **Search:** results match by prefix first, then by word prefix, then by substring (for queries of 3 or more characters). Ties are broken by points, then polygons, then lines, then shorter names. At most 20 results.
- **GPS** uses `maplibregl.GeolocateControl` with `trackUserLocation` and `showUserHeading`.
- **Outward-facing steps** — creating a GitHub repo, making it public, pushing, enabling Pages — happen ONLY after an explicit user confirmation in Task 8.

## File Structure

```
web/src/dem/hgt.ts            HGT names, decoding, terrain-RGB encode/decode
web/src/dem/overview.ts       OverviewBuilder, encode/decode overview grid
web/src/dem/dem.ts            Dem: mosaic geometry, tile(z,x,y) → RGBA
web/src/search/normalize.ts   Icelandic-aware normalisation
web/src/search/places.ts      collectPlaces(map) → Place[]
web/src/search/placeIndex.ts  PlaceIndex.search()
web/src/storage/store.ts      main-thread OPFS API
web/src/storage/storageWorker.ts   import/copy/overview/writeText in a worker
web/src/app/startup.ts        startApp(): stored → viewer, else import
web/src/app/importScreen.ts   import UI
web/src/app/viewer.ts         map, protocols, GPS, search UI, badge, debug perf
web/src/map/decodeAll.ts      (modify) optional { bits } filter
web/src/style/buildStyle.ts   (modify) optional dem source + hillshade layer
web/src/worker/tileWorker.ts  (modify) open with hgt/overview; 'dem' and 'places' messages
web/src/worker/pool.ts        (modify) OpenPayload; dem(); places()
web/src/main.ts               (replace) → startApp()
web/index.html                (replace) app shell
web/public/manifest.webmanifest, web/public/sw.js, web/public/icons/icon-{192,512}.png
web/scripts/make-icons.py, web/scripts/e2e.mjs (replaces screenshots.mjs)
web/test/dem.test.ts, web/test/search.test.ts
.github/workflows/pages.yml
README.md                     (modify) web app section
```

---

### Task 1: DEM core — HGT decoding, overview, on-demand terrain-RGB tiles

**Files:**
- Create: `web/src/dem/hgt.ts`, `web/src/dem/overview.ts`, `web/src/dem/dem.ts`, `web/test/dem.test.ts`
- Modify: `web/package.json` (devDependency `pngjs`)

**Interfaces:**
- Consumes: `ByteSource`, `ImgError` and `pyRound` (from `src/map/zoom.ts`).
- Produces:
  - `HGT_SIZE = 1201`, `HGT_STEP = 1200` and `HGT_BYTES = 1201 * 1201 * 2`;
  - `parseHgtName(name): {south, west} | null`;
  - `decodeHgt(bytes: Uint8Array): Int16Array`, which reads big-endian values and sets negatives to 0;
  - `encodeTerrainRgb(h, out: Uint8ClampedArray, i)` and `decodeTerrainRgb(r, g, b)`;
  - `interface Overview { step, west, north, rows, cols, data: Int16Array }`;
  - `class OverviewBuilder(tiles: Array<{south, west}>, step = 8)`, with `.add(south, west, samples: Int16Array)` and `.finish(): Overview`;
  - `encodeOverview(o): Uint8Array` and `decodeOverview(bytes): Overview`;
  - `class Dem`, with:
    - `static fromFiles(files: Array<{name: string; src: ByteSource}>, overview: Overview | null): Dem`;
    - `bounds: [w, s, e, n]`;
    - `tile(z, x, y): Promise<Uint8ClampedArray>` (256×256 RGBA);
  - `OVERVIEW_MAX_ZOOM = 8`.

- [ ] **Step 1: Install the test dependency**

Run: `cd web && npm install --save-dev pngjs @types/pngjs; cd ..`
Expected: installs.

- [ ] **Step 2: Write the failing tests**

`web/test/dem.test.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { Dem } from '../src/dem/dem';
import { decodeHgt, decodeTerrainRgb, encodeTerrainRgb, HGT_BYTES, HGT_SIZE, parseHgtName } from '../src/dem/hgt';
import { decodeOverview, encodeOverview, OverviewBuilder } from '../src/dem/overview';
import { BlobSource } from '../src/img/source';
import { latToTileY, lonToTileX } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { REPO } from './helpers/paths';

const HGT_DIR = REPO + 'GPSmap.is 2024.21 Android/HILLSHADE - Add content to DEM folder/';
const PY_DEM = REPO + 'out/dem.mbtiles';

/** A synthetic tile whose height is a function of (row, col) inside the file. */
function makeHgt(f: (r: number, c: number) => number): Uint8Array {
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run test/dem.test.ts; cd ..`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`web/src/dem/hgt.ts`:
```ts
import { pyRound } from '../map/zoom';

export const HGT_SIZE = 1201;
export const HGT_STEP = 1200;
export const HGT_BYTES = HGT_SIZE * HGT_SIZE * 2;

export function parseHgtName(name: string): { south: number; west: number } | null {
  const base = name.split('/').pop() ?? name;
  const m = /^([ns])(\d{2})([ew])(\d{3})\.hgt$/i.exec(base);
  if (!m) return null;
  return {
    south: (m[1].toLowerCase() === 'n' ? 1 : -1) * Number(m[2]),
    west: (m[3].toLowerCase() === 'e' ? 1 : -1) * Number(m[4]),
  };
}

/** Big-endian int16 samples; voids (-32768) and negative heights become 0, as in imgconv/hillshade.py. */
export function decodeHgt(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = ((bytes[2 * i] << 8) | bytes[2 * i + 1]) << 16 >> 16;
    out[i] = v < 0 ? 0 : v;
  }
  return out;
}

export function encodeTerrainRgb(h: number, out: Uint8ClampedArray, i: number): void {
  const v = pyRound((Math.max(h, 0) + 10000) * 10);
  out[i] = Math.floor(v / 65536) % 256;
  out[i + 1] = Math.floor(v / 256) % 256;
  out[i + 2] = v % 256;
  out[i + 3] = 255;
}

export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}
```

`web/src/dem/overview.ts`:
```ts
import { ImgError } from '../img/bytes';
import { HGT_SIZE, HGT_STEP } from './hgt';

/** A decimated mosaic: sample (r, c) is at lat = north - r*step/1200, lon = west + c*step/1200. */
export interface Overview {
  step: number;
  west: number;
  north: number;
  rows: number;
  cols: number;
  data: Int16Array;
}

export class OverviewBuilder {
  private readonly o: Overview;
  private readonly southMax: number;
  private readonly westMin: number;

  constructor(tiles: Array<{ south: number; west: number }>, step = 8) {
    if (HGT_STEP % step) throw new Error('overview step must divide 1200');
    const souths = tiles.map((t) => t.south);
    const wests = tiles.map((t) => t.west);
    this.southMax = Math.max(...souths);
    this.westMin = Math.min(...wests);
    const nLat = this.southMax - Math.min(...souths) + 1;
    const nLon = Math.max(...wests) - this.westMin + 1;
    const rows = (nLat * HGT_STEP) / step + 1;
    const cols = (nLon * HGT_STEP) / step + 1;
    this.o = { step, west: this.westMin, north: this.southMax + 1, rows, cols, data: new Int16Array(rows * cols) };
  }

  add(south: number, west: number, samples: Int16Array): void {
    const { step, cols, data } = this.o;
    const r0 = ((this.southMax - south) * HGT_STEP) / step;
    const c0 = ((west - this.westMin) * HGT_STEP) / step;
    for (let r = 0; r <= HGT_STEP / step; r++) {
      for (let c = 0; c <= HGT_STEP / step; c++) data[(r0 + r) * cols + c0 + c] = samples[r * step * HGT_SIZE + c * step];
    }
  }

  finish(): Overview {
    return this.o;
  }
}

const MAGIC = 0x4f4d4544; // "DEMO" little-endian

export function encodeOverview(o: Overview): Uint8Array {
  const out = new Uint8Array(24 + o.data.length * 2);
  const dv = new DataView(out.buffer);
  [MAGIC, o.step, o.west, o.north, o.rows, o.cols].forEach((v, i) => dv.setInt32(i * 4, v, true));
  for (let i = 0; i < o.data.length; i++) dv.setInt16(24 + i * 2, o.data[i], true);
  return out;
}

export function decodeOverview(bytes: Uint8Array): Overview {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || dv.getInt32(0, true) !== MAGIC) throw new ImgError('dem-overview.bin: bad header');
  const [step, west, north, rows, cols] = [1, 2, 3, 4, 5].map((i) => dv.getInt32(i * 4, true));
  if (bytes.length !== 24 + rows * cols * 2) throw new ImgError('dem-overview.bin: truncated');
  const data = new Int16Array(rows * cols);
  for (let i = 0; i < data.length; i++) data[i] = dv.getInt16(24 + i * 2, true);
  return { step, west, north, rows, cols, data };
}
```

`web/src/dem/dem.ts`:
```ts
import { ImgError } from '../img/bytes';
import type { ByteSource } from '../img/source';
import { decodeHgt, encodeTerrainRgb, HGT_BYTES, HGT_SIZE, HGT_STEP, parseHgtName } from './hgt';
import type { Overview } from './overview';

export const TILE_SIZE = 256;
export const OVERVIEW_MAX_ZOOM = 8;
const ROW_BYTES = HGT_SIZE * 2;

interface Placed {
  name: string;
  src: ByteSource;
  row0: number; // mosaic row of the file's north edge
  col0: number; // mosaic column of the file's west edge
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z)) * 180) / Math.PI;

function bilinear(get: (r: number, c: number) => number, row: number, col: number, rows: number, cols: number): number {
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(r0 + 1, rows - 1);
  const c1 = Math.min(c0 + 1, cols - 1);
  const fr = row - r0;
  const fc = col - c0;
  const top = get(r0, c0) * (1 - fc) + get(r0, c1) * fc;
  const bottom = get(r1, c0) * (1 - fc) + get(r1, c1) * fc;
  return top * (1 - fr) + bottom * fr;
}

export class Dem {
  private constructor(
    private readonly files: Placed[],
    private readonly rows: number,
    private readonly cols: number,
    private readonly overview: Overview | null,
    /** [west, south, east, north] of the mosaic in degrees */
    readonly bounds: [number, number, number, number],
  ) {}

  static fromFiles(input: Array<{ name: string; src: ByteSource }>, overview: Overview | null): Dem {
    if (!input.length) throw new ImgError('no .hgt files');
    const parsed = input.map((f) => {
      const p = parseHgtName(f.name);
      if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
      if (f.src.size !== HGT_BYTES) throw new ImgError(`${f.name}: not a 1201×1201 SRTM3 tile (${f.src.size} bytes)`);
      return { ...f, ...p };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const southMin = Math.min(...parsed.map((p) => p.south));
    const southMax = Math.max(...parsed.map((p) => p.south));
    const westMin = Math.min(...parsed.map((p) => p.west));
    const westMax = Math.max(...parsed.map((p) => p.west));
    const rows = (southMax - southMin + 1) * HGT_STEP + 1;
    const cols = (westMax - westMin + 1) * HGT_STEP + 1;
    const files = parsed.map((p) => ({ name: p.name, src: p.src, row0: (southMax - p.south) * HGT_STEP, col0: (p.west - westMin) * HGT_STEP }));
    return new Dem(files, rows, cols, overview, [westMin, southMin, westMax + 1, southMax + 1]);
  }

  async tile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
    const [west, south, east, north] = this.bounds;
    const lons = Array.from({ length: TILE_SIZE }, (_, px) => tileLon(x + (px + 0.5) / TILE_SIZE, z));
    const lats = Array.from({ length: TILE_SIZE }, (_, py) => tileLat(y + (py + 0.5) / TILE_SIZE, z));
    const out = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);

    let sample: (lon: number, lat: number) => number;
    if (this.overview && z <= OVERVIEW_MAX_ZOOM) {
      const o = this.overview;
      const per = HGT_STEP / o.step;
      sample = (lon, lat) => bilinear(
        (r, c) => o.data[r * o.cols + c],
        Math.min(Math.max((o.north - lat) * per, 0), o.rows - 1),
        Math.min(Math.max((lon - o.west) * per, 0), o.cols - 1),
        o.rows, o.cols,
      );
    } else {
      sample = await this.fullResSampler(lons, lats);
    }

    for (let py = 0; py < TILE_SIZE; py++) {
      const lat = lats[py];
      for (let px = 0; px < TILE_SIZE; px++) {
        const lon = lons[px];
        const outside = lat < south || lat > north || lon < west || lon > east;
        encodeTerrainRgb(outside ? 0 : sample(lon, lat), out, (py * TILE_SIZE + px) * 4);
      }
    }
    return out;
  }

  /** Reads one row band per intersecting file into a patch covering exactly the rows/cols this tile needs. */
  private async fullResSampler(lons: number[], lats: number[]): Promise<(lon: number, lat: number) => number> {
    const [west, , , north] = this.bounds;
    const rowOf = (lat: number) => Math.min(Math.max((north - lat) * HGT_STEP, 0), this.rows - 1);
    const colOf = (lon: number) => Math.min(Math.max((lon - west) * HGT_STEP, 0), this.cols - 1);
    const rMin = Math.floor(rowOf(lats[0]));
    const rMax = Math.min(Math.ceil(rowOf(lats[lats.length - 1])) + 1, this.rows - 1);
    const cMin = Math.floor(colOf(lons[0]));
    const cMax = Math.min(Math.ceil(colOf(lons[lons.length - 1])) + 1, this.cols - 1);
    const pr = rMax - rMin + 1;
    const pc = cMax - cMin + 1;
    const patch = new Int16Array(pr * pc);

    await Promise.all(this.files.map(async (f) => {
      const r0 = Math.max(rMin, f.row0);
      const r1 = Math.min(rMax, f.row0 + HGT_STEP);
      const c0 = Math.max(cMin, f.col0);
      const c1 = Math.min(cMax, f.col0 + HGT_STEP);
      if (r0 > r1 || c0 > c1) return;
      const lr0 = r0 - f.row0;
      const band = decodeHgt(await f.src.read(lr0 * ROW_BYTES, (r1 - r0 + 1) * ROW_BYTES));
      return () => {
        for (let r = r0; r <= r1; r++) {
          const src = (r - r0) * HGT_SIZE - f.col0;
          const dst = (r - rMin) * pc - cMin;
          for (let c = c0; c <= c1; c++) patch[dst + c] = band[src + c];
        }
      };
    })).then((writers) => writers.forEach((w) => w?.())); // apply in file-name order, like the Python mosaic

    return (lon, lat) => bilinear((r, c) => patch[(r - rMin) * pc + (c - cMin)], rowOf(lat), colOf(lon), this.rows, this.cols);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run test/dem.test.ts && npx tsc --noEmit; cd ..`
Expected: all pass, including the golden test against `out/dem.mbtiles` (maximum difference ≤ 0.2 m on four tiles). If the golden test fails, compare against `imgconv/hillshade.py`'s `_sample`/`_render_tile`; do not loosen the tolerance.

- [ ] **Step 6: Commit**

```bash
git add web/src/dem web/test/dem.test.ts web/package.json web/package-lock.json
git commit -m "Add on-demand terrain-RGB DEM tiles from SRTM .hgt files"
```

---

### Task 2: Place search

**Files:**
- Create: `web/src/search/normalize.ts`, `web/src/search/places.ts`, `web/src/search/placeIndex.ts`, `web/test/search.test.ts`
- Modify: `web/src/map/decodeAll.ts` (optional `{ bits }`)

**Interfaces:**
- Consumes: `GarminMap`, `objectName`, `decodeAll`, `CONTOUR_LINE_TYPES`, `isNumber` and `mapUnitsToDeg`.
- Produces:
  - `normalize(s): string`;
  - `interface Place { name: string; lon: number; lat: number; kind: 'point' | 'line' | 'polygon'; type: number }`;
  - `collectPlaces(map): Promise<Place[]>`;
  - `class PlaceIndex(places)`, with `.search(query, limit = 20): Place[]`;
  - `decodeAll(map, visit, opts?: { bits?: number })`.

- [ ] **Step 1: Write the failing tests**

`web/test/search.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GarminMap } from '../src/map/garminMap';
import { normalize } from '../src/search/normalize';
import { PlaceIndex } from '../src/search/placeIndex';
import { collectPlaces } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

describe('normalize', () => {
  test('Icelandic letters and diacritics', () => {
    expect(normalize('Þórsmörk')).toBe('thorsmork');
    expect(normalize('Hvannadalshnúkur')).toBe('hvannadalshnukur');
    expect(normalize('ÆGISÍÐA')).toBe('aegisida');
    expect(normalize('  Fjallabak-syðra ')).toBe('fjallabak sydra');
  });
});

describe('PlaceIndex', () => {
  const idx = new PlaceIndex([
    { name: 'Laugavegur', lon: 0, lat: 0, kind: 'line', type: 0x16 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'point', type: 0x2f06 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'polygon', type: 0x13 },
    { name: 'Hveragerði', lon: 2, lat: 2, kind: 'point', type: 0x0400 },
    { name: 'Efri Laugar', lon: 3, lat: 3, kind: 'point', type: 0x0400 },
  ]);

  test('prefix beats word-prefix beats substring; points first', () => {
    expect(idx.search('lau').map((p) => [p.name, p.kind])).toEqual([
      ['Laugavegur', 'line'],
      ['Efri Laugar', 'point'],
      ['Landmannalaugar', 'point'],
      ['Landmannalaugar', 'polygon'],
    ]);
    expect(idx.search('landm')[0]).toMatchObject({ name: 'Landmannalaugar', kind: 'point' });
    expect(idx.search('hverag')[0].name).toBe('Hveragerði');
    expect(idx.search('')).toEqual([]);
    expect(idx.search('la', 2)).toHaveLength(2);
  });
});

describe.skipIf(!hasRealData)('search on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let idx: PlaceIndex;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    const places = await collectPlaces(await GarminMap.open(src));
    console.log(`places: ${places.length}`);
    idx = new PlaceIndex(places);
  }, 300_000);
  afterAll(() => src.close());

  test('finds well-known places', () => {
    const lm = idx.search('landmannalaugar')[0];
    expect(Math.abs(lm.lon - -19.06)).toBeLessThan(0.1);
    expect(Math.abs(lm.lat - 63.99)).toBeLessThan(0.1);
    expect(idx.search('thorsmork').some((p) => normalize(p.name) === 'thorsmork')).toBe(true);
    expect(normalize(idx.search('reykjav')[0].name).startsWith('reykjavik')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/search.test.ts; cd ..`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

In `web/src/map/decodeAll.ts`, change the signature and filter as follows (everything else unchanged):
```ts
export async function decodeAll(
  map: GarminMap,
  visit: (tile: MapTile, sd: Subdivision, obj: RawObject) => void | false,
  opts: { bits?: number } = {},
): Promise<DecodeStats> {
```
and in the `wanted` computation, keep only levels that have a band AND (if `opts.bits` is set) equal `opts.bits`:
```ts
    const wanted = new Set([...tile.byLevel]
      .filter(([bits]) => map.bands.has(bits) && (opts.bits === undefined || bits === opts.bits))
      .flatMap(([, sds]) => sds));
```

`web/src/search/normalize.ts`:
```ts
const LETTERS: Record<string, string> = { þ: 'th', ð: 'd', æ: 'ae', ö: 'o', ø: 'o' };

/** Lower-case, Icelandic letters spelled out, diacritics dropped, punctuation → single spaces. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[þðæöø]/g, (c) => LETTERS[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
```

`web/src/search/places.ts`:
```ts
import { mapUnitsToDeg } from '../img/bytes';
import type { Kind } from '../img/rgn';
import { decodeAll } from '../map/decodeAll';
import { objectName, type GarminMap } from '../map/garminMap';
import { CONTOUR_LINE_TYPES, isNumber } from '../map/zoom';
import { normalize } from './normalize';

export interface Place {
  name: string;
  lon: number;
  lat: number;
  kind: Kind;
  type: number;
}

/** Named objects of the most detailed level, deduplicated by name within ~0.05°. */
export async function collectPlaces(map: GarminMap): Promise<Place[]> {
  const bits = Math.max(...map.bands.keys());
  const seen = new Set<string>();
  const out: Place[] = [];
  await decodeAll(map, (tile, _sd, obj) => {
    if (obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type)) return;
    const name = objectName(tile, obj);
    if (!name || isNumber(name)) return;
    let lon: number;
    let lat: number;
    if (obj.kind === 'point') {
      [lon, lat] = obj.coords[0].map(mapUnitsToDeg);
    } else {
      const xs = obj.coords.map((c) => c[0]);
      const ys = obj.coords.map((c) => c[1]);
      lon = mapUnitsToDeg((Math.min(...xs) + Math.max(...xs)) / 2);
      lat = mapUnitsToDeg((Math.min(...ys) + Math.max(...ys)) / 2);
    }
    const key = `${normalize(name)}|${obj.kind}|${Math.round(lon * 20)}|${Math.round(lat * 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, lon, lat, kind: obj.kind, type: obj.type });
  }, { bits });
  return out;
}
```

`web/src/search/placeIndex.ts`:
```ts
import { normalize } from './normalize';
import type { Place } from './places';

const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;

interface Entry {
  place: Place;
  norm: string;
  words: string[];
}

export class PlaceIndex {
  private readonly entries: Entry[];

  constructor(places: Place[]) {
    this.entries = places.map((place) => {
      const norm = normalize(place.name);
      return { place, norm, words: norm.split(' ') };
    });
  }

  search(query: string, limit = 20): Place[] {
    const q = normalize(query);
    if (!q) return [];
    const hits: Array<[number, number, number, string, Place]> = [];
    for (const e of this.entries) {
      let score: number;
      if (e.norm.startsWith(q)) score = 0;
      else if (e.words.some((w) => w.startsWith(q))) score = 1;
      else if (q.length >= 3 && e.norm.includes(q)) score = 2;
      else continue;
      hits.push([score, KIND_RANK[e.place.kind], e.norm.length, e.place.name, e.place]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]));
    return hits.slice(0, limit).map((h) => h[4]);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit; cd ..`
Expected: every test passes, including golden.test.ts, which is unchanged by the optional `decodeAll` parameter. Report the real-data places count printed by the test.

- [ ] **Step 5: Commit**

```bash
git add web/src/search web/src/map/decodeAll.ts web/test/search.test.ts
git commit -m "Add Icelandic-aware place search built from the map's own labels"
```

---

### Task 3: On-device storage (OPFS) and import worker

**Files:**
- Create: `web/src/storage/store.ts`, `web/src/storage/storageWorker.ts`

**Interfaces:**
- Consumes: `GarminMap`, `BlobSource`, `parseHgtName`, `decodeHgt`, `HGT_BYTES`, `OverviewBuilder`, `encodeOverview` and `ImgError`.
- Produces:
  - `interface StoredMeta { version: 1; imgName; imgSize; imgLastModified; hgtNames: string[]; hasOverview: boolean }`;
  - `interface Stored { meta; img: File; hgt: File[]; overview: File | null }`;
  - `loadStored(): Promise<Stored | null>`;
  - `importFiles(img: File, hgt: File[], onProgress: (msg: string) => void): Promise<void>`;
  - `readText(name): Promise<string | null>`;
  - `writeText(name, text): Promise<void>`;
  - `clearStored(): Promise<void>`;
  - `requestPersistence(): Promise<boolean>`;
  - `cacheKey(meta): string`.

OPFS is not available in Node, so this task has no unit tests. It is verified end to end in Task 7 (headless Chrome: import, reload from storage, then an offline reload). Keep the code small and direct.

- [ ] **Step 1: Implement the worker**

`web/src/storage/storageWorker.ts`:
```ts
/// <reference lib="webworker" />
import { decodeHgt, HGT_BYTES, parseHgtName } from '../dem/hgt';
import { encodeOverview, OverviewBuilder } from '../dem/overview';
import { ImgError } from '../img/bytes';
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';

declare const self: DedicatedWorkerGlobalScope;

const DIR = 'garmin';
const CHUNK = 8 * 1024 * 1024;

const progress = (message: string) => self.postMessage({ type: 'progress', message });

async function writeBytes(dir: FileSystemDirectoryHandle, name: string, write: (h: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    handle.truncate(0);
    await write(handle);
    handle.flush();
  } finally {
    handle.close();
  }
}

async function doImport(img: File, hgt: File[]): Promise<void> {
  progress('Checking map file…');
  await GarminMap.open(new BlobSource(img)); // throws a tile-named ImgError for locked/corrupt maps
  const parsed = hgt.map((f) => {
    const p = parseHgtName(f.name);
    if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
    if (f.size !== HGT_BYTES) throw new ImgError(`${f.name}: not a 1201×1201 SRTM3 tile (${f.size} bytes)`);
    return { file: f, name: f.name.toLowerCase(), ...p };
  });

  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);
  const dir = await root.getDirectoryHandle(DIR, { create: true });

  await writeBytes(dir, 'map.img', async (h) => {
    for (let off = 0; off < img.size; off += CHUNK) {
      h.write(new Uint8Array(await img.slice(off, off + CHUNK).arrayBuffer()), { at: off });
      progress(`Copying map ${Math.min(100, Math.round(((off + CHUNK) / img.size) * 100))}%`);
    }
  });

  if (parsed.length) {
    const demDir = await dir.getDirectoryHandle('dem', { create: true });
    const builder = new OverviewBuilder(parsed);
    for (const [i, p] of parsed.entries()) {
      const bytes = new Uint8Array(await p.file.arrayBuffer());
      await writeBytes(demDir, p.name, async (h) => void h.write(bytes, { at: 0 }));
      builder.add(p.south, p.west, decodeHgt(bytes));
      progress(`Copying elevation ${i + 1}/${parsed.length}`);
    }
    const ov = encodeOverview(builder.finish());
    await writeBytes(dir, 'dem-overview.bin', async (h) => void h.write(ov, { at: 0 }));
  }

  const meta = {
    version: 1, imgName: img.name, imgSize: img.size, imgLastModified: img.lastModified,
    hgtNames: parsed.map((p) => p.name).sort(), hasOverview: parsed.length > 0,
  };
  const text = new TextEncoder().encode(JSON.stringify(meta));
  await writeBytes(dir, 'meta.json', async (h) => void h.write(text, { at: 0 })); // written last: commit marker
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'import') await doImport(msg.img as File, msg.hgt as File[]);
    else if (msg.type === 'writeText') {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
      const bytes = new TextEncoder().encode(msg.text as string);
      await writeBytes(dir, msg.name as string, async (h) => void h.write(bytes, { at: 0 }));
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
```

- [ ] **Step 2: Implement the main-thread API**

`web/src/storage/store.ts`:
```ts
const DIR = 'garmin';

export interface StoredMeta {
  version: 1;
  imgName: string;
  imgSize: number;
  imgLastModified: number;
  hgtNames: string[];
  hasOverview: boolean;
}

export interface Stored {
  meta: StoredMeta;
  img: File;
  hgt: File[];
  overview: File | null;
}

export const cacheKey = (m: StoredMeta) => `${m.imgName}|${m.imgSize}|${m.imgLastModified}`;

async function dir(create = false): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create });
}

const isMissing = (err: unknown) => err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

export async function loadStored(): Promise<Stored | null> {
  try {
    const d = await dir();
    const meta = JSON.parse(await (await (await d.getFileHandle('meta.json')).getFile()).text()) as StoredMeta;
    const img = await (await d.getFileHandle('map.img')).getFile();
    if (meta.version !== 1 || img.size !== meta.imgSize) return null;
    const demDir = meta.hgtNames.length ? await d.getDirectoryHandle('dem') : null;
    const hgt = demDir ? await Promise.all(meta.hgtNames.map(async (n) => (await demDir.getFileHandle(n)).getFile())) : [];
    const overview = meta.hasOverview ? await (await d.getFileHandle('dem-overview.bin')).getFile() : null;
    return { meta, img, hgt, overview };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function readText(name: string): Promise<string | null> {
  try {
    return await (await (await dir()).getFileHandle(name)).getFile().then((f) => f.text());
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function runWorker(msg: Record<string, unknown>, onProgress?: (m: string) => void): Promise<void> {
  const w = new Worker(new URL('./storageWorker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.message);
      else if (m.type === 'done') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'storage worker failed'));
    w.postMessage(msg);
  }).finally(() => w.terminate());
}

export const importFiles = (img: File, hgt: File[], onProgress: (m: string) => void) => runWorker({ type: 'import', img, hgt }, onProgress);
export const writeText = (name: string, text: string) => runWorker({ type: 'writeText', name, text });

export async function clearStored(): Promise<void> {
  await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }).catch(() => undefined);
}

export async function requestPersistence(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
```

- [ ] **Step 3: Typecheck and commit**

Run: `cd web && npx tsc --noEmit && npx vitest run; cd ..`
Expected: clean, with all tests passing. If TypeScript lacks the `FileSystemSyncAccessHandle` types under the current `lib` settings, confirm that `"WebWorker"` is in tsconfig `lib` (it is), and add a minimal ambient declaration in `web/src/types/opfs.d.ts` only if it is still missing. Say so in the report.

```bash
git add web/src/storage
git commit -m "Store map and elevation files in OPFS via an import worker"
```

---

### Task 4: Workers serve DEM tiles and places

**Files:**
- Modify: `web/src/worker/tileWorker.ts`, `web/src/worker/pool.ts`

**Interfaces:**
- Consumes: `Dem`, `decodeOverview`, `collectPlaces` and `BlobSource`.
- Produces:
  - `interface OpenPayload { file: File; hgt: File[]; overview: File | null }`;
  - `new TilePool(payload: OpenPayload, size)`;
  - `open()` now returns `{ bounds, typ, tileIds, demBounds: [w, s, e, n] | null }`;
  - `pool.dem(z, x, y): Promise<{ bitmap: ImageBitmap; ms: number }>`;
  - `pool.places(): Promise<Place[]>`.

The worker messages are:
- `open { file, hgt, overview }` → `opened { …, demBounds }`;
- `dem { z, x, y }` → `dem { bitmap, ms }`, with the bitmap transferred;
- `places {}` → `places { places }`.

- [ ] **Step 1: Update the worker**

In `web/src/worker/tileWorker.ts`:
- add `let dem: Dem | null = null;`
- extend the `open` branch;
- add two message branches.

The resulting handler code:
```ts
import { Dem } from '../dem/dem';
import { decodeOverview } from '../dem/overview';
import { collectPlaces } from '../search/places';
// ...existing imports...

let dem: Dem | null = null;

// inside self.onmessage, replacing the 'open' branch:
    if (msg.type === 'open') {
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const m = await opened;
      const hgt = (msg.hgt ?? []) as File[];
      if (hgt.length) {
        const overview = msg.overview ? decodeOverview(new Uint8Array(await (msg.overview as File).arrayBuffer())) : null;
        dem = Dem.fromFiles(hgt.map((f) => ({ name: f.name, src: new BlobSource(f) })), overview);
      }
      self.postMessage({ type: 'opened', id: msg.id, bounds: m.bounds, typ: m.typ, tileIds: m.tiles.map((t) => t.id), demBounds: dem?.bounds ?? null });
    } else if (msg.type === 'dem') {
      if (!dem) throw new Error('no elevation data loaded');
      const t0 = performance.now();
      const rgba = await dem.tile(msg.z, msg.x, msg.y);
      const bitmap = await createImageBitmap(new ImageData(rgba, 256, 256));
      self.postMessage({ type: 'dem', id: msg.id, bitmap, ms: performance.now() - t0 }, [bitmap]);
    } else if (msg.type === 'places') {
      if (!opened) throw new Error('map not opened');
      self.postMessage({ type: 'places', id: msg.id, places: await collectPlaces(await opened) });
    }
    // the existing 'tile' branch stays as is
```

- [ ] **Step 2: Update the pool**

In `web/src/worker/pool.ts`, which now has the Plan 1 fix round's respawn and error handling:
- (a) Replace the constructor's `file: File` with `payload: OpenPayload`. Every place that sends the `open` message, including any respawn path, sends `{ type: 'open', ...this.payload }`.
- (b) Extend `OpenMeta` with `demBounds`.
- (c) Add these methods, using the same routing function as `tile()` for `dem()`:
```ts
export interface OpenPayload {
  file: File;
  hgt: File[];
  overview: File | null;
}

  dem(z: number, x: number, y: number): Promise<{ bitmap: ImageBitmap; ms: number }> {
    // same worker choice as tile(z, x, y)
  }

  /** Builds the place list on the first worker (decodes the finest level once). */
  places(): Promise<Place[]> {
    // call the first live worker with { type: 'places' } and resolve with msg.places
  }
```
Implement the bodies with the pool's existing `call`/routing helpers. Keep the respawn and dead-worker behaviour intact for these messages too.

- [ ] **Step 3: Typecheck, test, commit**

Run: `cd web && npx tsc --noEmit && npx vitest run; cd ..`
Expected: clean and passing. The worker paths are exercised end to end in Task 7.

```bash
git add web/src/worker
git commit -m "Serve DEM tiles and place lists from the tile workers"
```

---

### Task 5: Hillshade in the style

**Files:**
- Modify: `web/src/style/buildStyle.ts`, `web/test/style.test.ts`

**Interfaces:**
- `buildStyle(typ, opts: { tiles: string; glyphs: string; dem?: string; demBounds?: [number, number, number, number] })`.
- When `dem` is given:
  - add the source `dem: {type: 'raster-dem', tiles: [dem], tileSize: 256, minzoom: 5, maxzoom: 11, encoding: 'mapbox', bounds?: demBounds}`;
  - add the layer `hillshade` (type `hillshade`, source `dem`) right after the last polygon fill layer and before `ln-other`, with the paint used by `imgconv/stylegen.py`: `hillshade-exaggeration` 0.5, shadow and accent `#5a4a3a`, highlight `#ffffff`.

- [ ] **Step 1: Write the failing test** (append to `web/test/style.test.ts`)

```ts
  test('hillshade when a dem source is given', () => {
    const { style } = buildStyle(emptyTyp(), { ...OPTS, dem: 'dem://{z}/{x}/{y}', demBounds: [-25, 63, -13, 67] });
    const ids = style.layers.map((l) => l.id);
    const lastFill = Math.max(...ids.map((id, i) => (id.startsWith('pg-') && id !== 'pg-labels' ? i : -1)));
    expect(ids.indexOf('hillshade')).toBe(lastFill + 1);
    expect(ids.indexOf('hillshade')).toBeLessThan(ids.indexOf('ln-other'));
    expect(style.sources.dem).toEqual({
      type: 'raster-dem', tiles: ['dem://{z}/{x}/{y}'], tileSize: 256, minzoom: 5, maxzoom: 11, encoding: 'mapbox', bounds: [-25, 63, -13, 67],
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/style.test.ts; cd ..`
Expected: FAIL (there is no `hillshade` layer).

- [ ] **Step 3: Implement**

In `buildStyle`, after the polygon loop and before the `ln-other` push:
```ts
  if (opts.dem) {
    layers.push({
      id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#5a4a3a', 'hillshade-accent-color': '#5a4a3a', 'hillshade-highlight-color': '#ffffff' },
    } as LayerSpecification);
  }
```
and when building `sources`:
```ts
  const sources: StyleSpecification['sources'] = { garmin: { type: 'vector', tiles: [opts.tiles], minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM } };
  if (opts.dem) {
    sources.dem = { type: 'raster-dem', tiles: [opts.dem], tileSize: 256, minzoom: 5, maxzoom: 11, encoding: 'mapbox', ...(opts.demBounds ? { bounds: opts.demBounds } : {}) };
  }
```
Update the `opts` type accordingly.

- [ ] **Step 4: Run tests, commit**

Run: `cd web && npx vitest run && npx tsc --noEmit; cd ..`
Expected: all pass.

```bash
git add web/src/style/buildStyle.ts web/test/style.test.ts
git commit -m "Add optional hillshade layer from on-the-fly DEM tiles"
```

---

### Task 6: App shell — import screen, viewer with GPS and search

**Files:**
- Replace: `web/index.html`, `web/src/main.ts`
- Create: `web/src/app/startup.ts`, `web/src/app/importScreen.ts`, `web/src/app/viewer.ts`
- Keep: `web/src/ui/perf.ts` (shown only with `?debug`) and `web/src/ui/images.ts` (`preloadImages`, from the Plan 1 fix round)

**Interfaces:**
- Consumes: the storage API (Task 3), `TilePool`/`OpenPayload` (Task 4), `buildStyle` with `dem` (Task 5), `PlaceIndex`, `parseTyp`/`emptyTyp`, and `PerfStats`.
- Produces: `window.__app = { map, ready, placesReady, search(q): Place[] | null, perf, samples }`, used by the e2e script in Task 7.

- [ ] **Step 1: Page**

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#2c5a85" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="apple-touch-icon" href="./icons/icon-192.png" />
    <title>Garmin Map</title>
    <style>
      :root { --ink: #1d2a38; --paper: #f4f0e4; --accent: #2c5a85; }
      html, body { margin: 0; height: 100%; font: 15px -apple-system, system-ui, sans-serif; color: var(--ink); background: var(--paper); }
      #map { position: absolute; inset: 0; }
      .panel { background: #fffffff0; border-radius: 10px; box-shadow: 0 1px 6px #0003; }
      #topbar { position: absolute; z-index: 3; top: calc(env(safe-area-inset-top) + 8px); left: 8px; right: 56px; max-width: 420px; }
      #search { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 16px; border: 0; }
      #results { list-style: none; margin: 4px 0 0; padding: 0; max-height: 50vh; overflow: auto; }
      #results li { padding: 9px 12px; border-top: 1px solid #0001; cursor: pointer; }
      #results li small { color: #667; margin-left: 6px; }
      #badge { position: absolute; z-index: 3; left: 8px; bottom: calc(env(safe-area-inset-bottom) + 28px); padding: 6px 10px; font-size: 13px; color: #8a3b00; }
      #replace { position: absolute; z-index: 3; left: 8px; bottom: calc(env(safe-area-inset-bottom) + 64px); padding: 6px 10px; border: 0; font-size: 13px; }
      #perf { position: absolute; z-index: 3; right: 8px; bottom: calc(env(safe-area-inset-bottom) + 28px); padding: 6px 8px; font: 11px ui-monospace, monospace; white-space: pre; }
      #import { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; background: var(--paper); padding: 16px; }
      #import .card { max-width: 440px; padding: 20px; }
      #import label { display: block; margin: 14px 0 4px; font-weight: 600; }
      #import button { margin-top: 18px; padding: 10px 16px; font-size: 16px; border: 0; border-radius: 8px; background: var(--accent); color: white; }
      #import-error { color: #b00020; white-space: pre-wrap; margin-top: 12px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div id="topbar" class="panel" hidden>
      <input id="search" type="search" placeholder="Search places" autocomplete="off" enterkeyhint="search" />
      <ul id="results"></ul>
    </div>
    <div id="badge" class="panel" hidden></div>
    <button id="replace" class="panel" hidden>Load another map</button>
    <div id="perf" class="panel" hidden></div>
    <section id="import" hidden>
      <div class="card panel">
        <h2>Load your map</h2>
        <p>Pick the Garmin <code>.img</code> map file. Add the <code>.hgt</code> elevation files for hillshading (optional). They are stored on this device only.</p>
        <label for="img-file">Map (.img)</label>
        <input id="img-file" type="file" accept=".img" />
        <label for="hgt-files">Elevation (.hgt, select all)</label>
        <input id="hgt-files" type="file" accept=".hgt" multiple />
        <div><button id="import-button">Import</button></div>
        <div id="import-progress"></div>
        <div id="import-error"></div>
      </div>
    </section>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/main.ts`:
```ts
import 'maplibre-gl/dist/maplibre-gl.css';
import { startApp } from './app/startup';

void startApp();
```

- [ ] **Step 2: Startup and import screen**

`web/src/app/startup.ts`:
```ts
import { loadStored } from '../storage/store';
import { showImport } from './importScreen';
import { startViewer } from './viewer';

export async function startApp(): Promise<void> {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register(new URL('./sw.js', document.baseURI)).catch((err) => console.warn('service worker', err));
  }
  let stored = null;
  try {
    stored = await loadStored();
  } catch (err) {
    console.error(err);
  }
  if (!stored) return showImport();
  try {
    await startViewer(stored);
  } catch (err) {
    showImport(`Could not open the stored map: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

`web/src/app/importScreen.ts`:
```ts
import { importFiles, requestPersistence } from '../storage/store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function showImport(error = ''): void {
  $('import').hidden = false;
  $('import-error').textContent = error;
  $<HTMLButtonElement>('import-button').onclick = async () => {
    const img = $<HTMLInputElement>('img-file').files?.[0];
    const hgt = [...($<HTMLInputElement>('hgt-files').files ?? [])];
    if (!img) {
      $('import-error').textContent = 'Pick the .img map file first.';
      return;
    }
    $('import-error').textContent = '';
    $<HTMLButtonElement>('import-button').disabled = true;
    try {
      await requestPersistence();
      await importFiles(img, hgt, (m) => ($('import-progress').textContent = m));
      location.reload();
    } catch (err) {
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      $<HTMLButtonElement>('import-button').disabled = false;
    }
  };
}
```

- [ ] **Step 3: Viewer**

`web/src/app/viewer.ts`:
```ts
import * as maplibregl from 'maplibre-gl';
import { emptyTyp, parseTyp } from '../img/typ';
import { PlaceIndex } from '../search/placeIndex';
import type { Place } from '../search/places';
import { cacheKey, clearStored, readText, writeText, type Stored } from '../storage/store';
import { buildStyle } from '../style/buildStyle';
import { preloadImages } from '../ui/images';
import { PerfStats } from '../ui/perf';
import { TilePool } from '../worker/pool';

const SAMPLES: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: 'reykjavik-z14', center: [-21.94, 64.146], zoom: 14 },
  { name: 'landmannalaugar-z12', center: [-19.06, 63.99], zoom: 12 },
  { name: 'vatnajokull-z10', center: [-16.9, 64.02], zoom: 10 },
  { name: 'iceland-z6', center: [-18.6, 64.9], zoom: 6 },
];

declare global {
  interface Window {
    __app?: {
      map: maplibregl.Map;
      perf: PerfStats;
      ready: boolean;
      placesReady: boolean;
      search: (q: string) => Place[] | null;
      samples: typeof SAMPLES;
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const parseZxy = (url: string) => {
  const m = /^[a-z]+:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) throw new Error(`bad tile url ${url}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};

export async function startViewer(stored: Stored): Promise<void> {
  const pool = new TilePool({ file: stored.img, hgt: stored.hgt, overview: stored.overview }, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
  const meta = await pool.open();
  const debug = new URLSearchParams(location.search).has('debug');
  const perf = new PerfStats($('perf'));
  $('perf').hidden = !debug;
  let bad = 0;

  maplibregl.addProtocol('garmin', async (params) => {
    const r = await pool.tile(...parseZxy(params.url));
    perf.record(r.ms, r.badSections, r.features);
    if (r.badSections) {
      bad += r.badSections;
      $('badge').hidden = false;
      $('badge').textContent = `⚠ ${bad} map section${bad === 1 ? '' : 's'} could not be decoded`;
    }
    return { data: r.data };
  });
  if (meta.demBounds) maplibregl.addProtocol('dem', async (params) => ({ data: (await pool.dem(...parseZxy(params.url))).bitmap }));

  const typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  const glyphs = new URL('fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  const { style, images } = buildStyle(typ, {
    tiles: 'garmin://{z}/{x}/{y}', glyphs,
    ...(meta.demBounds ? { dem: 'dem://{z}/{x}/{y}', demBounds: meta.demBounds } : {}),
  });
  const [w, s, e, n] = meta.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[w, s], [e, n]], maxZoom: 18, attributionControl: false });
  preloadImages(map, images); // before any tile request; see src/ui/images.ts
  map.on('styleimagemissing', (ev) => {
    const img = images.get(ev.id);
    if (img && !map.hasImage(ev.id)) map.addImage(ev.id, img);
  });
  map.on('error', (ev) => console.error(ev.error));
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  $('topbar').hidden = false;
  $('replace').hidden = false;
  $('replace').onclick = async () => {
    if (!confirm('Remove the stored map from this device and load another?')) return;
    await clearStored();
    location.reload();
  };

  const app = { map, perf, ready: false, placesReady: false, search: (_q: string): Place[] | null => null, samples: SAMPLES };
  window.__app = app;
  map.once('idle', () => (app.ready = true));

  void loadPlaces(stored, pool).then((index) => {
    app.search = (q) => index.search(q);
    app.placesReady = true;
    wireSearch(map, index);
  }).catch((err) => console.error('search index', err));
}

async function loadPlaces(stored: Stored, pool: TilePool): Promise<PlaceIndex> {
  const key = cacheKey(stored.meta);
  const cached = await readText('places.json');
  if (cached) {
    const parsed = JSON.parse(cached) as { key: string; places: Place[] };
    if (parsed.key === key) return new PlaceIndex(parsed.places);
  }
  const places = await pool.places();
  await writeText('places.json', JSON.stringify({ key, places }));
  return new PlaceIndex(places);
}

function wireSearch(map: maplibregl.Map, index: PlaceIndex): void {
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('results');
  let marker: maplibregl.Marker | null = null;
  let timer = 0;
  const render = () => {
    list.replaceChildren(...index.search(input.value).map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name;
      const kind = document.createElement('small');
      kind.textContent = p.kind === 'point' ? 'place' : p.kind === 'polygon' ? 'area' : 'route';
      li.append(kind);
      li.onclick = () => {
        map.flyTo({ center: [p.lon, p.lat], zoom: p.kind === 'point' ? 14 : 12 });
        marker?.remove();
        marker = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([p.lon, p.lat]).addTo(map);
        list.replaceChildren();
        input.blur();
      };
      return li;
    }));
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(render, 120);
  });
}
```

- [ ] **Step 4: Typecheck, build, test**

Run: `cd web && npx tsc --noEmit && npm run build && npx vitest run; cd ..`
Expected: clean, building and passing. Remove `web/scripts/screenshots.mjs` and its npm script now, because it targets the old `#file` input; Task 7 replaces it.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/src/main.ts web/src/app web/package.json
git rm web/scripts/screenshots.mjs
git commit -m "Add app shell: import screen, stored-map startup, GPS and place search"
```

---

### Task 7: Installable offline PWA and end-to-end verification

**Files:**
- Create: `web/public/manifest.webmanifest`, `web/public/sw.js`, `web/scripts/make-icons.py`, `web/public/icons/icon-192.png`, `web/public/icons/icon-512.png` (both generated), and `web/scripts/e2e.mjs`
- Modify: `web/package.json` (the `e2e` script)

**Interfaces:**
- Produces: `npm run e2e`, which builds the app, serves it with `vite preview`, and in headless Chrome:
  1. imports the IMG and all HGT files;
  2. waits for the map;
  3. screenshots four locations with hillshade to `out/web-samples/*-hillshade.png`;
  4. checks search;
  5. reloads and opens straight from storage;
  6. goes offline and reloads successfully;
  7. prints the perf summary.

  It exits non-zero on any failure.

- [ ] **Step 1: Manifest and icons**

`web/public/manifest.webmanifest`:
```json
{
  "name": "Garmin Map",
  "short_name": "Map",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#f4f0e4",
  "theme_color": "#2c5a85",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

`web/scripts/make-icons.py`:
```python
"""Generate the app icons (run with the repo's .venv: ../.venv/bin/python scripts/make-icons.py)."""
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "public" / "icons"
out.mkdir(parents=True, exist_ok=True)
for size in (192, 512):
    s = size
    img = Image.new("RGBA", (s, s), "#2c5a85")
    d = ImageDraw.Draw(img)
    d.polygon([(0.10 * s, 0.80 * s), (0.42 * s, 0.28 * s), (0.58 * s, 0.54 * s), (0.69 * s, 0.40 * s), (0.92 * s, 0.80 * s)], fill="#f4f0e4")
    d.polygon([(0.35 * s, 0.40 * s), (0.42 * s, 0.28 * s), (0.49 * s, 0.40 * s)], fill="#ffffff")
    img.save(out / f"icon-{size}.png")
    print("wrote", out / f"icon-{size}.png")
```
Run: `cd web && ../.venv/bin/python scripts/make-icons.py; cd ..`
Expected: two PNGs written.

- [ ] **Step 2: Service worker**

`web/public/sw.js`:
```js
/* Offline support: precache the shell and fonts; cache everything else same-origin on first use. */
const CACHE = 'garmin-map-v1';
const FONTS = ['Noto Sans Regular', 'Noto Sans Italic'].flatMap((f) =>
  ['0-255', '256-511', '8192-8447'].map((r) => `fonts/${encodeURIComponent(f)}/${r}.pbf`));
const PRECACHE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', ...FONTS];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./', copy));
        return res;
      })
      .catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    });
    return hit || net;
  }));
});
```

- [ ] **Step 3: End-to-end script**

`web/scripts/e2e.mjs`:
```js
import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA = REPO + 'GPSmap.is 2024.21 Android/';
const IMG = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
const HGT_DIR = DATA + 'HILLSHADE - Add content to DEM folder/';
const OUT = REPO + 'out/web-samples/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5198;

const fail = (msg) => {
  throw new Error(`E2E FAILED: ${msg}`);
};

await mkdir(OUT, { recursive: true });
const hgts = (await readdir(HGT_DIR)).filter((n) => n.endsWith('.hgt')).map((n) => HGT_DIR + n);
const server = await preview({ root: WEB, preview: { port: PORT, strictPort: true } });
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024 });
  page.on('console', (m) => ['error', 'warn'].includes(m.type()) && console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const waitReady = () => page.waitForFunction(() => window.__app?.ready === true, { timeout: 300_000 });

  // 1. first run: import screen
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#import:not([hidden])', { timeout: 30_000 });
  await (await page.$('#img-file')).uploadFile(IMG);
  await (await page.$('#hgt-files')).uploadFile(...hgts);
  const t0 = Date.now();
  await Promise.all([page.waitForNavigation({ timeout: 600_000 }), page.click('#import-button')]);
  console.log(`import took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await waitReady();

  // 2. screenshots with hillshade
  const samples = await page.evaluate(() => window.__app.samples);
  for (const s of samples) {
    await page.evaluate((c, z) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('idle timeout')), 120_000);
      window.__app.map.jumpTo({ center: c, zoom: z });
      window.__app.map.once('idle', () => { clearTimeout(t); resolve(); });
    }), s.center, s.zoom);
    await page.screenshot({ path: `${OUT}${s.name}-hillshade.png` });
    console.log('wrote', `${OUT}${s.name}-hillshade.png`);
  }
  console.log(await page.evaluate(() => window.__app.perf.summary()));

  // 3. search
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  const hit = await page.evaluate(() => window.__app.search('landmannalaugar')[0]);
  if (!hit || Math.abs(hit.lon + 19.06) > 0.1 || Math.abs(hit.lat - 63.99) > 0.1) fail(`search landmannalaugar → ${JSON.stringify(hit)}`);
  console.log('search ok:', hit.name, hit.lon.toFixed(3), hit.lat.toFixed(3));

  // 4. reload opens straight from storage
  await page.reload();
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('import screen shown after reload');
  console.log('reload from storage ok');

  // 5. offline reload
  await page.setOfflineMode(true);
  await page.reload();
  await waitReady();
  console.log('offline reload ok');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
```

In `web/package.json`, set `scripts.e2e` to `"npm run build && node scripts/e2e.mjs"`.

- [ ] **Step 4: Run it**

Run: `cd web && npm run e2e; cd ..`
Expected:
- the import time is printed;
- four `*-hillshade.png` files are written;
- the perf summary line shows 0 bad sections;
- `search ok: …` near (-19.06, 63.99);
- `reload from storage ok` and `offline reload ok`;
- exit code 0.

Look at the four hillshade PNGs with the Read tool. Relief should be visible and match the raster samples in `out/iceland-gpsmap-is-2024-21-detailed/samples/`. If the offline reload fails, check that the SW registered (`import.meta.env.PROD` in preview) and that `./` is precached.

- [ ] **Step 5: Commit**

```bash
git add web/public/manifest.webmanifest web/public/sw.js web/public/icons web/scripts/make-icons.py web/scripts/e2e.mjs web/package.json
git commit -m "Make the app installable and offline-capable; add end-to-end test"
```

---

### Task 8: GitHub Pages deployment (requires user confirmation)

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `README.md` (web app section)

- [ ] **Step 1: Workflow**

`.github/workflows/pages.yml`:
```yaml
name: Deploy web app to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - run: npm run build
        working-directory: web
      - uses: actions/upload-pages-artifact@v3
        with:
          path: web/dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: README section** (append to `README.md`)

````markdown
## Web app (on-the-fly, iPhone and Mac)

`web/` is a browser app that renders the Garmin `.img` directly, with no pre-rendered tiles. It adds hillshade from the `.hgt` files, place search and GPS, and works offline once installed.

```bash
cd web && npm install
npm run dev        # http://localhost:5173
npm test           # unit + golden tests (golden tests need the GPSmap.is files and out/ reference data)
npm run e2e        # full headless-Chrome check: import, hillshade, search, offline
```

On the iPhone, open the GitHub Pages URL in Safari, then use Share → Add to Home Screen. Open the app, tap Import, and pick the `.img` and the `.hgt` files from the Files app. They stay on the device.
````

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml README.md
git commit -m "Add GitHub Pages deployment workflow and web app README"
```

- [ ] **Step 4: STOP — ask the user before anything outward-facing**

Report to the user and ask for explicit confirmation of:
- (a) the GitHub repo name and owner, and whether it may be **public** (free Pages requires it; only code is published, never map data);
- (b) how `web-app` gets to `main`, for example a merge of `img-converter` then `web-app` into `main`, or a PR;
- (c) permission to run the publishing commands.

After confirmation only, the commands are:
```bash
gh auth status
gh repo create <owner>/<name> --public --source . --remote origin
git push -u origin main
gh api -X POST repos/<owner>/<name>/pages -f build_type=workflow
gh run watch
```
Finally, give the user the Pages URL and the iPhone install steps from the README.

## Deviations from the spec

- The search cache is stored in OPFS (`places.json`) instead of IndexedDB, so all app data lives in one store. Its behaviour is the same.
- DEM tiles at z5–8 come from a step-8 overview built once at import. Full-resolution reads at those zooms would touch up to all 48 files (138 MB) per tile. z9–11 are computed on demand from the HGT row bands and match Python exactly.
