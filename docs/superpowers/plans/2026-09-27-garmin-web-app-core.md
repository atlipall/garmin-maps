# Garmin Web App — Plan 1: On-the-fly Core + Performance Spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser app in `web/` that opens a Garmin IMG file and renders it with MapLibre GL JS, decoding vector tiles on the fly in Web Workers. It includes timing instrumentation, so we can decide go/no-go on the architecture.

**Architecture:**
- A TypeScript port of the verified Python decoder (`imgconv`) reads byte ranges of the IMG on demand through a `ByteSource`.
- `GarminMap` loads the headers, the label tables and the TYP, and computes global zoom bands.
- `buildTile(z, x, y)` decodes only the subdivisions that intersect the tile at the level for that zoom, clips the features and encodes an MVT tile.
- MapLibre gets tiles through `addProtocol('garmin')`, which forwards to a pool of workers.
- The style is generated at load from the TYP.

**Tech Stack:** TypeScript, Vite 8, Vitest 5, MapLibre GL JS 6, `@maplibre/vt-pbf`, `lineclip`, and `puppeteer-core` (driving the local Chrome for screenshots).

**Spec:** `docs/superpowers/specs/2026-09-27-garmin-web-app-design.md`

**Scope:** This is Plan 1 of 2. It covers the spec's `img/`, `tiles/` and `style/` modules, a viewer and the performance spike. Plan 2 will cover hillshade (`dem/`), search, GPS, the PWA and deployment. It is written only after the spike passes the user's go/no-go review in Task 11.

## Global Constraints

- All code lives in `web/`. The repo is `/Users/atli/projects/maps`, and the branch is `web-app`.
- Never commit anything under `out/`, `web/node_modules/`, `web/public/fonts/` or `web/dist/`, and never commit the GPSmap.is data.
- This is a faithful port of `imgconv` (Python, same repo) and must carry over every verified fact and ruling:
  - Images are unscrambled (XOR byte 0).
  - The FAT starts after zero slots at 0x200. The FAT part number is big-endian at 0x10–0x11. Parts must be contiguous from 0. After the scan starts, non-1 slots are skipped up to `header_end`.
  - RGN subdivision offsets are 24-bit and wrap, so they must be unwrapped.
  - Locking is detected only via TRE byte 0x0D & 0x80.
  - A section that fails or ends misaligned contributes zero objects and counts as a bad section.
  - Labels are encoding 9 (8-bit), codepage 1252. Each label part is tagged with the separator that precedes it; a numeric part after 0x1F is feet and is converted to `"<m> m"`.
  - Contour lines 0x20–0x25 have their labels converted from feet to metres, using Python's round-half-to-even.
  - Zoom bands use MapLibre zoom: `minzoom = bits − 11`, clamped to 4–14; the coarsest level with data starts at 4; bands are computed across all map tiles.
- Type codes:
  - a standard point is `(type<<8)|subtype`;
  - a standard line is `t & 0x3F`, and a standard polygon is `t & 0x7F`;
  - extended types are `0x10000|(type<<8)|(subtype&0x1F)`.
- The MVT layers are `points`, `lines` and `polygons`, with properties `t` (the type as an integer) and `name`. Extent is 4096 and the buffer is 64.
- Error messages name the tile and subfile, e.g. `14057403.TRE: …`, and use `ImgError`.
- Real-data tests use `describe.skipIf(!hasRealData)`. The Python decoder's reference output for the Detailed map is in `out/iceland-gpsmap-is-2024-21-detailed/`: `features.geojsonseq`, `types.json` and `decode-stats.json` (sections 51368, bad 0, features 1,989,249).
- Library APIs, verified on 2026-09-27:
  - `maplibregl.addProtocol(name, async (params, abortController) => ({ data: ArrayBuffer }))`.
  - `import { fromGeojsonVt } from '@maplibre/vt-pbf'`. It takes geojson-vt-style features `{type: 1|2|3, geometry, tags}`. Point geometry is `[[x,y]]`; line geometry is `[[[x,y],…], …]`; polygon rings are closed. It returns a `Uint8Array`.
  - `import { clipPolyline, clipPolygon } from 'lineclip'`.
  - For tests, the vector tile reader is `import { VectorTile } from '@mapbox/vector-tile'` with `import { PbfReader } from 'pbf'`.

## File Structure

```
web/package.json, tsconfig.json, vite.config.ts, index.html, .gitignore
web/scripts/copy-fonts.mjs          copy ../assets/fonts → public/fonts
web/scripts/screenshots.mjs         headless Chrome screenshots + perf summary
web/src/types/lineclip.d.ts
web/src/img/bytes.ts                ImgError, bounds-checked readers, ascii, mapUnitsToDeg
web/src/img/source.ts               ByteSource, BlobSource
web/src/img/container.ts            IMG FAT → subfile block lists, ranged reads
web/src/img/bitstream.ts            delta decoder
web/src/img/tre.ts                  levels, subdivisions (+ bounds), ext ranges
web/src/img/rgn.ts                  objects per subdivision from byte chunks
web/src/img/lbl.ts                  labels
web/src/img/typ.ts                  TYP styles
web/src/map/zoom.ts                 zoomBands, contourLabel, pyRound
web/src/map/garminMap.ts            GarminMap.open, levelForZoom, readSubdivision
web/src/map/decodeAll.ts            whole-map iteration (golden test, later search)
web/src/tiles/tileMath.ts           tile bounds / lon-lat ↔ tile
web/src/tiles/buildTile.ts          SubdivisionCache, buildTile
web/src/style/fallback.ts           default colours/widths/priorities
web/src/style/buildStyle.ts         MapLibre style + images from TYP
web/src/worker/tileWorker.ts        worker: open map, build tiles
web/src/worker/pool.ts              TilePool
web/src/ui/perf.ts                  PerfStats overlay
web/src/main.ts                     viewer
web/test/helpers/paths.ts, nodeSource.ts, builders.ts
web/test/*.test.ts
```

---

### Task 1: Scaffold `web/`, bytes and sources

**Files:**
- Create: `web/package.json` (via npm), `web/tsconfig.json`, `web/vite.config.ts`, `web/.gitignore`, `web/scripts/copy-fonts.mjs`, `web/src/types/lineclip.d.ts`, `web/src/img/bytes.ts`, `web/src/img/source.ts`
- Create: `web/test/helpers/paths.ts`, `web/test/helpers/nodeSource.ts`, `web/test/bytes.test.ts`

**Interfaces:**
- Produces:
  - `ImgError`;
  - `u8/u16/s16/u24/s24/u32(b: Uint8Array, o: number): number`, which throw `RangeError` when reading out of range;
  - `ascii(b, start, end): string`;
  - `mapUnitsToDeg(v): number`;
  - `interface ByteSource { size: number; read(offset, length): Promise<Uint8Array> }`;
  - `class BlobSource`;
  - test helpers `nodeSource(path)`, `REPO`, `DETAILED`, `PY_OUT` and `hasRealData`.

- [ ] **Step 1: Create the package**

```bash
mkdir -p web/src/img web/src/types web/test/helpers web/scripts && cd web
npm init -y >/dev/null
npm pkg set name=garmin-web private=true type=module
npm pkg set scripts.fonts="node scripts/copy-fonts.mjs" scripts.predev="npm run fonts" scripts.dev="vite" \
  scripts.prebuild="npm run fonts" scripts.build="vite build" scripts.test="vitest run" \
  scripts.typecheck="tsc --noEmit" scripts.screenshots="node scripts/screenshots.mjs"
npm install maplibre-gl @maplibre/vt-pbf lineclip
npm install --save-dev vite vitest typescript @types/node @mapbox/vector-tile pbf puppeteer-core
cd ..
```
Expected: the installs succeed. Check that `web/package.json` has `"private": true` as a boolean; fix it by hand if npm wrote the string `"true"`.

`web/.gitignore`:
```
dist/
public/fonts/
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "types": ["vite/client", "node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
```

`web/scripts/copy-fonts.mjs`:
```js
import { cp } from 'node:fs/promises';

const src = new URL('../../assets/fonts/', import.meta.url);
const dst = new URL('../public/fonts/', import.meta.url);
await cp(src, dst, { recursive: true });
console.log('fonts copied');
```

`web/src/types/lineclip.d.ts`:
```ts
declare module 'lineclip' {
  type Pt = [number, number];
  type BBox = [number, number, number, number];
  export function clipPolyline(points: Pt[], bbox: BBox, result?: Pt[][]): Pt[][];
  export function clipPolygon(points: Pt[], bbox: BBox): Pt[];
}
```

- [ ] **Step 2: Write the failing tests**

`web/test/helpers/paths.ts`:
```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DETAILED =
  REPO + 'GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
export const PY_OUT = REPO + 'out/iceland-gpsmap-is-2024-21-detailed/';
export const hasRealData = existsSync(DETAILED);
```

`web/test/helpers/nodeSource.ts`:
```ts
import { open } from 'node:fs/promises';
import type { ByteSource } from '../../src/img/source';

export async function nodeSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(offset: number, length: number) {
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}
```

`web/test/bytes.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ascii, mapUnitsToDeg, s16, s24, u16, u24, u32 } from '../src/img/bytes';
import { BlobSource } from '../src/img/source';

const b = new Uint8Array([0x34, 0x12, 0xff, 0xff, 0x80, 0x01, 0x02, 0x03, 0x04, 0x47, 0x41]);

describe('bytes', () => {
  test('little-endian readers', () => {
    expect(u16(b, 0)).toBe(0x1234);
    expect(s16(b, 2)).toBe(-1);
    expect(u24(b, 5)).toBe(0x030201);
    expect(s24(b, 2)).toBe(-0x7f0001);
    expect(u32(b, 5)).toBe(0x04030201);
    expect(u32(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0)).toBe(0xffffffff);
    expect(ascii(b, 9, 11)).toBe('GA');
    expect(mapUnitsToDeg(1 << 23)).toBe(180);
  });

  test('out-of-range reads throw RangeError', () => {
    expect(() => u16(b, 10)).toThrow(RangeError);
    expect(() => u24(b, -1)).toThrow(RangeError);
  });

  test('BlobSource reads ranges', async () => {
    const src = new BlobSource(new Blob([b]));
    expect(src.size).toBe(11);
    expect([...(await src.read(1, 3))]).toEqual([0x12, 0xff, 0xff]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run test/bytes.test.ts; cd ..`
Expected: FAIL (cannot resolve `../src/img/bytes`).

- [ ] **Step 4: Implement**

`web/src/img/bytes.ts`:
```ts
export class ImgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImgError';
  }
}

export function u8(b: Uint8Array, o: number): number {
  if (o < 0 || o >= b.length) throw new RangeError(`read past end at offset ${o} (length ${b.length})`);
  return b[o];
}

export function u16(b: Uint8Array, o: number): number {
  return u8(b, o) | (u8(b, o + 1) << 8);
}

export function s16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
}

export function u24(b: Uint8Array, o: number): number {
  return u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16);
}

export function s24(b: Uint8Array, o: number): number {
  const v = u24(b, o);
  return v & 0x800000 ? v - 0x1000000 : v;
}

export function u32(b: Uint8Array, o: number): number {
  return u24(b, o) + u8(b, o + 3) * 0x1000000;
}

export function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

export function mapUnitsToDeg(v: number): number {
  return (v * 360) / 16777216;
}
```

`web/src/img/source.ts`:
```ts
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class BlobSource implements ByteSource {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit; cd ..`
Expected: 3 passed, and tsc exits 0. If TypeScript 7's `tsc` rejects the config, run `npm install --save-dev typescript@^5` and re-run the typecheck, noting the change in the report.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts web/.gitignore web/scripts web/src web/test
git commit -m "Scaffold web app with byte readers and sources"
```

---

### Task 2: IMG container

**Files:**
- Create: `web/src/img/container.ts`, `web/test/helpers/builders.ts`, `web/test/container.test.ts`

**Interfaces:**
- Consumes: `ByteSource`, `ImgError`, `ascii`, `u16` and `u32` from Task 1.
- Produces:
  - `class ImgContainer`, with:
    - `static open(src: ByteSource): Promise<ImgContainer>`;
    - `tileIds(): string[]` (sorted, from `*.TRE`);
    - `has(name): boolean`;
    - `size(name): number`;
    - `firstOfType(ext): string | undefined` (a subfile name);
    - `read(name, start = 0, length?): Promise<Uint8Array>`, which maps through the block list.
  - Builder `buildImg(files: Record<string, Uint8Array>, blockSize = 512, blocksPerEntry = 240): Uint8Array`, plus `concat(...parts)`.

- [ ] **Step 1: Write the builder and failing tests**

`web/test/helpers/builders.ts`:
```ts
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesOf(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function packS24(v: number): Uint8Array {
  const u = v & 0xffffff;
  return new Uint8Array([u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff]);
}

function fatEntry(name: string, ext: string, size: number, part: number, blocks: number[]): Uint8Array {
  const e = new Uint8Array(512);
  const dv = new DataView(e.buffer);
  e[0] = 1;
  e.set(bytesOf(name.padEnd(8)), 1);
  e.set(bytesOf(ext.padEnd(3)), 9);
  dv.setUint32(0x0c, size, true);
  e[0x10] = part >> 8;
  e[0x11] = part & 0xff;
  for (let i = 0; i < 240; i++) dv.setUint16(0x20 + 2 * i, i < blocks.length ? blocks[i] : 0xffff, true);
  return e;
}

/** Build a minimal Garmin IMG disk image holding `files` ({"NAME.EXT": bytes}). */
export function buildImg(files: Record<string, Uint8Array>, blockSize = 512, blocksPerEntry = 240): Uint8Array {
  const layout: Array<[string, Uint8Array, number]> = [];
  let fatEntries = 1;
  for (const [name, data] of Object.entries(files)) {
    const nblocks = Math.max(1, Math.ceil(data.length / blockSize));
    fatEntries += Math.ceil(nblocks / blocksPerEntry);
    layout.push([name, data, nblocks]);
  }
  const headerEnd = Math.ceil((0x200 + 512 * fatEntries) / blockSize) * blockSize;
  const hdr = new Uint8Array(headerEnd);
  hdr.set(bytesOf('DSKIMG'), 0x10);
  hdr[0x61] = 9;
  hdr[0x62] = Math.log2(blockSize) - 9;
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  hdr.set(fatEntry('', '', headerEnd, 0, range(0, headerEnd / blockSize)), 0x200);
  const body: Uint8Array[] = [];
  let next = headerEnd / blockSize;
  let off = 0x400;
  for (const [fname, data, nblocks] of layout) {
    const [name, ext] = fname.split('.');
    const blocks = range(next, next + nblocks);
    for (let part = 0, i = 0; i < nblocks; part++, i += blocksPerEntry) {
      hdr.set(fatEntry(name, ext, part === 0 ? data.length : 0, part, blocks.slice(i, i + blocksPerEntry)), off);
      off += 512;
    }
    const padded = new Uint8Array(nblocks * blockSize);
    padded.set(data);
    body.push(padded);
    next += nblocks;
  }
  return concat(hdr, ...body);
}
```

`web/test/container.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ImgError } from '../src/img/bytes';
import { ImgContainer } from '../src/img/container';
import { BlobSource } from '../src/img/source';
import { buildImg, bytesOf } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const open = (bytes: Uint8Array) => ImgContainer.open(new BlobSource(new Blob([bytes])));
const filled = (n: number, c: string) => new Uint8Array(n).fill(c.charCodeAt(0));

describe('ImgContainer', () => {
  test('reads subfiles', async () => {
    const img = await open(buildImg({ '00000001.TRE': filled(700, 'T'), '00000001.RGN': filled(10, 'R'), '103F2.TYP': filled(3, 'Y') }));
    expect(img.tileIds()).toEqual(['00000001']);
    expect(await img.read('00000001.TRE')).toEqual(filled(700, 'T'));
    expect(await img.read('00000001.TRE', 690, 20)).toEqual(filled(10, 'T'));
    expect(img.firstOfType('TYP')).toBe('103F2.TYP');
    expect(img.has('missing.XYZ')).toBe(false);
  });

  test('joins multi-part entries and reads across blocks', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => i % 256);
    const img = await open(buildImg({ 'A.RGN': data }, 512, 3));
    expect(await img.read('A.RGN')).toEqual(data);
    expect(await img.read('A.RGN', 500, 1100)).toEqual(data.subarray(500, 1600));
  });

  test('rejects non-IMG and scrambled images', async () => {
    await expect(open(new Uint8Array(4096))).rejects.toThrow(/DSKIMG/);
    const raw = buildImg({ 'A.TRE': bytesOf('x') });
    raw[0] = 0x5a;
    await expect(open(raw)).rejects.toThrow(/XOR/);
  });

  test('rejects duplicate part numbers', async () => {
    const raw = buildImg({ 'A.RGN': new Uint8Array(5120) }, 512, 3);
    raw[0x600 + 0x10] = 0;
    raw[0x600 + 0x11] = 0;
    await expect(open(raw)).rejects.toThrow(ImgError);
  });

  test('assembles parts stored out of order', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => (i * 7) % 256);
    const raw = buildImg({ 'A.RGN': data }, 512, 3);
    const a = raw.slice(0x600, 0x800);
    raw.set(raw.slice(0x800, 0xa00), 0x600);
    raw.set(a, 0x800);
    expect(await (await open(raw)).read('A.RGN')).toEqual(data);
  });

  test('skips a zeroed FAT slot between entries', async () => {
    const raw = buildImg({ 'A.TRE': filled(10, 'a'), 'B.TRE': filled(10, 'b'), 'C.TRE': filled(10, 'c') });
    raw.fill(0, 0x600, 0x800);
    const img = await open(raw);
    expect(await img.read('A.TRE')).toEqual(filled(10, 'a'));
    expect(await img.read('C.TRE')).toEqual(filled(10, 'c'));
    expect(img.has('B.TRE')).toBe(false);
  });
});

describe.skipIf(!hasRealData)('ImgContainer on real data', () => {
  test('Detailed IMG', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    expect(img.tileIds()).toEqual(['14057401', '14057402', '14057403', '14057405', '14057406']);
    expect(img.size('14057403.RGN')).toBe(17504055);
    const typ = await img.read(img.firstOfType('TYP')!, 0, 12);
    expect(String.fromCharCode(...typ.subarray(2, 12))).toBe('GARMIN TYP');
    await src.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/container.test.ts; cd ..`
Expected: FAIL (cannot resolve `../src/img/container`).

- [ ] **Step 3: Implement**

`web/src/img/container.ts`:
```ts
import { ascii, ImgError, u16, u32 } from './bytes';
import type { ByteSource } from './source';

const FAT_ENTRY = 512;

interface SubfileInfo {
  size: number;
  blocks: number[];
}

interface ScanResult {
  headerEnd: number | null;
  parts: Map<string, { size: number; parts: Map<number, number[]> }>;
}

function scanFat(data: Uint8Array): ScanResult {
  const parts: ScanResult['parts'] = new Map();
  let headerEnd: number | null = null;
  let started = false;
  let off = 0x200;
  while (off + FAT_ENTRY <= data.length) {
    if (headerEnd !== null && off >= headerEnd) break;
    const e = data.subarray(off, off + FAT_ENTRY);
    off += FAT_ENTRY;
    if (e[0] !== 1) {
      if (started) {
        if (headerEnd !== null) continue; // header size known: skip free slots
        break;
      }
      continue;
    }
    started = true;
    const name = ascii(e, 1, 9).trim();
    const ext = ascii(e, 9, 12).trim();
    const size = u32(e, 0x0c);
    const part = (e[0x10] << 8) | e[0x11];
    const blocks: number[] = [];
    for (let i = 0; i < 240; i++) {
      const b = u16(e, 0x20 + 2 * i);
      if (b !== 0xffff) blocks.push(b);
    }
    if (!name && !ext) {
      headerEnd = size; // this entry describes the header area; its size ends the FAT
      continue;
    }
    const key = `${name}.${ext}`;
    let entry = parts.get(key);
    if (!entry) {
      entry = { size: 0, parts: new Map() };
      parts.set(key, entry);
    }
    if (part === 0) entry.size = size;
    entry.parts.set(part, blocks);
  }
  return { headerEnd, parts };
}

export class ImgContainer {
  private constructor(
    private readonly src: ByteSource,
    private readonly blockSize: number,
    private readonly subfiles: Map<string, SubfileInfo>,
  ) {}

  static async open(src: ByteSource): Promise<ImgContainer> {
    let head = await src.read(0, Math.min(src.size, 0x10000));
    if (head.length < 0x200) throw new ImgError('not a Garmin IMG file (too small)');
    if (head[0] !== 0) {
      throw new ImgError(`XOR-scrambled IMG (xor byte 0x${head[0].toString(16).padStart(2, '0')}) is not supported`);
    }
    if (ascii(head, 0x10, 0x16) !== 'DSKIMG') throw new ImgError('not a Garmin IMG file (missing DSKIMG signature)');
    const blockSize = 2 ** (head[0x61] + head[0x62]);
    let scan = scanFat(head);
    const want = scan.headerEnd ?? Math.min(src.size, 4 * 1024 * 1024);
    if (want > head.length) {
      head = await src.read(0, Math.min(src.size, want));
      scan = scanFat(head);
    }
    if (scan.parts.size === 0) throw new ImgError('no subfiles found in the IMG FAT');
    const subfiles = new Map<string, SubfileInfo>();
    for (const [key, entry] of scan.parts) {
      const nums = [...entry.parts.keys()].sort((a, b) => a - b);
      if (nums.some((n, i) => n !== i)) throw new ImgError(`${key}: FAT parts [${nums}] are not contiguous from 0`);
      subfiles.set(key, { size: entry.size, blocks: nums.flatMap((n) => entry.parts.get(n)!) });
    }
    return new ImgContainer(src, blockSize, subfiles);
  }

  tileIds(): string[] {
    return [...this.subfiles.keys()].filter((k) => k.endsWith('.TRE')).map((k) => k.slice(0, -4)).sort();
  }

  has(name: string): boolean {
    return this.subfiles.has(name);
  }

  size(name: string): number {
    const sf = this.subfiles.get(name);
    if (!sf) throw new ImgError(`${name}: subfile not found`);
    return sf.size;
  }

  firstOfType(ext: string): string | undefined {
    return [...this.subfiles.keys()].sort().find((k) => k.endsWith(`.${ext}`));
  }

  async read(name: string, start = 0, length?: number): Promise<Uint8Array> {
    const sf = this.subfiles.get(name);
    if (!sf) throw new ImgError(`${name}: subfile not found`);
    const end = Math.min(sf.size, length === undefined ? sf.size : start + length);
    if (start >= end) return new Uint8Array(0);
    const bs = this.blockSize;
    const out = new Uint8Array(end - start);
    let pos = start;
    while (pos < end) {
      const bi = Math.floor(pos / bs);
      if (bi >= sf.blocks.length) throw new ImgError(`${name}: block list shorter than subfile size`);
      let run = 1;
      while (bi + run < sf.blocks.length && sf.blocks[bi + run] === sf.blocks[bi] + run && (bi + run) * bs < end) run++;
      const runEnd = Math.min(end, (bi + run) * bs);
      const chunk = await this.src.read(sf.blocks[bi] * bs + (pos % bs), runEnd - pos);
      if (chunk.length !== runEnd - pos) throw new ImgError(`${name}: IMG file truncated`);
      out.set(chunk, pos - start);
      pos = runEnd;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/container.test.ts && npx tsc --noEmit; cd ..`
Expected: 7 passed (including the real-data test), and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/img/container.ts web/test/helpers/builders.ts web/test/container.test.ts
git commit -m "Port IMG container with ranged subfile reads"
```

---

### Task 3: Bitstream

**Files:**
- Create: `web/src/img/bitstream.ts`, `web/test/bitstream.test.ts`

**Interfaces:**
- Produces: `setup(baseInfo, first, v2): [bx, by, SignInfo]` and `decodeDeltas(data: Uint8Array, baseInfo: number, v2: boolean, extraBit: boolean): Array<[number, number]>`.
- The implementation reads bits directly at a bit position; there is no 64-bit shift register, because JavaScript bitwise operators are 32-bit. The behaviour is identical to QMapShack's `CShiftReg`: decoding continues while at least `per` bits remain, and reads beyond the data return zero bits.

- [ ] **Step 1: Write the failing tests** (the same fixtures as the Python `tests/test_bitstream.py`)

`web/test/bitstream.test.ts`:
```ts
import { expect, test } from 'vitest';
import { decodeDeltas, setup } from '../src/img/bitstream';

const d = (bytes: number[], base: number, v2: boolean, extra: boolean) => decodeDeltas(new Uint8Array(bytes), base, v2, extra);

test('same sign positive', () => expect(d([0x95], 0x00, false, false)).toEqual([[1, 2]]));
test('same sign negative x', () => expect(d([0x97], 0x00, false, false)).toEqual([[-1, 2]]));
test('signed values', () => expect(d([0x7c], 0x00, false, false)).toEqual([[-1, 3]]));
test('signed escape extends magnitude', () => expect(d([0x50, 0x00], 0x00, false, false)).toEqual([[5, 0]]));
test('extra bit is skipped', () => expect(d([0x75, 0x05], 0x11, false, true)).toEqual([[3, 5]]));
test('v2 flag bit widens coords', () => {
  const [bx, by, sign] = setup(0x00, 0x05 | 0x10, true);
  expect([bx, by, sign.headerBits]).toEqual([3, 3, 5]);
});
test('v2 decode (trailing padding yields a zero delta)', () =>
  expect(d([0x25, 0x01], 0x00, true, false)).toEqual([[1, 2], [0, 0]]));
test('empty bitstream has no deltas', () => expect(d([], 0x00, false, false)).toEqual([]));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/bitstream.test.ts; cd ..`
Expected: FAIL (cannot resolve the module).

- [ ] **Step 3: Implement**

`web/src/img/bitstream.ts`:
```ts
/** Delta-coded polyline/polygon geometry (port of QMapShack's CShiftReg). */
export interface SignInfo {
  xSigned: boolean;
  xNeg: boolean;
  ySigned: boolean;
  yNeg: boolean;
  headerBits: number;
}

export function coordBits(base: number, signed: boolean): number {
  const n = 2 + (base <= 9 ? base : 2 * base - 9);
  return signed ? n + 1 : n;
}

export function setup(baseInfo: number, first: number, v2: boolean): [number, number, SignInfo] {
  let mask = 1;
  let headerBits = 2;
  const xSame = (first & mask) !== 0;
  mask <<= 1;
  let xNeg = false;
  if (xSame) {
    xNeg = (first & mask) !== 0;
    mask <<= 1;
    headerBits += 1;
  }
  let bx = coordBits(baseInfo & 0x0f, !xSame);
  const ySame = (first & mask) !== 0;
  mask <<= 1;
  let yNeg = false;
  if (ySame) {
    yNeg = (first & mask) !== 0;
    mask <<= 1;
    headerBits += 1;
  }
  let by = coordBits((baseInfo >> 4) & 0x0f, !ySame);
  if (v2) {
    headerBits += 1;
    if (first & mask) {
      bx += 1;
      by += 1;
    }
  }
  return [bx, by, { xSigned: !xSame, xNeg, ySigned: !ySame, yNeg, headerBits }];
}

class BitReader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length * 8 - this.pos;
  }

  peek(n: number): number {
    let v = 0;
    let m = 1;
    for (let i = 0; i < n; i++) {
      const p = this.pos + i;
      const byte = p >> 3 < this.data.length ? this.data[p >> 3] : 0;
      if ((byte >> (p & 7)) & 1) v += m;
      m *= 2;
    }
    return v;
  }

  take(n: number): number {
    const v = this.peek(n);
    this.pos += n;
    return v;
  }
}

export function decodeDeltas(data: Uint8Array, baseInfo: number, v2: boolean, extraBit: boolean): Array<[number, number]> {
  if (data.length === 0) return [];
  const [bx, by, sign] = setup(baseInfo, data[0], v2);
  const r = new BitReader(data);
  r.pos = sign.headerBits;
  const per = bx + by + (extraBit ? 1 : 0);

  const value = (n: number, signed: boolean, neg: boolean): number => {
    if (!signed) {
      const v = r.take(n);
      return neg && v ? -v : v;
    }
    const signBit = 2 ** (n - 1);
    let acc = 0;
    let t = r.peek(n);
    while (t === signBit) {
      acc += t - 1;
      r.pos += n;
      t = r.peek(n);
    }
    r.pos += n;
    return t < signBit ? acc + t : t - 2 * signBit - acc;
  };

  const out: Array<[number, number]> = [];
  while (r.remaining >= per) {
    if (extraBit) r.pos += 1;
    const x = value(bx, sign.xSigned, sign.xNeg);
    const y = value(by, sign.ySigned, sign.yNeg);
    out.push([x, y]);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/bitstream.test.ts && npx tsc --noEmit; cd ..`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/img/bitstream.ts web/test/bitstream.test.ts
git commit -m "Port RGN geometry bitstream decoder"
```

---

### Task 4: TRE parser (with subdivision bounds)

**Files:**
- Create: `web/src/img/tre.ts`, `web/test/tre.test.ts`
- Modify: `web/test/helpers/builders.ts` (append `makeRgnHeader`, `makeTre`)

**Interfaces:**
- Consumes: `bytes.ts`.
- Produces:
  - `KIND_POINTS=0x10`, `KIND_IDX_POINTS=0x20`, `KIND_LINES=0x40`, `KIND_POLYGONS=0x80`;
  - `type Range = [number, number]` and `EMPTY_EXT`;
  - `Level {number, bits, inherited, count}`;
  - `Subdivision {index, level, kinds, cx, cy, halfWidth, halfHeight, rgnStart, rgnEnd, ext: [Range, Range, Range]}`, where offsets are absolute in the RGN subfile and `ext` is ordered polygons2, lines2, points2;
  - `Tre {north, east, south, west, levels, subdivisions}`;
  - `shiftOf(sd)`, `hasData(sd)`, and `subdivisionBounds(sd): [w, s, e, n]` in map units;
  - `parseTre(tre: Uint8Array, rgnHeader: Uint8Array): Tre`.

- [ ] **Step 1: Add builders** (append to `web/test/helpers/builders.ts`)

```ts
export function makeRgnHeader(dataLen: number, ext: Array<[number, number]> = [[0, 0], [0, 0], [0, 0]], hlen = 0x7d): Uint8Array {
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN RGN'), 2);
  dv.setUint32(0x15, hlen, true);
  dv.setUint32(0x19, dataLen, true);
  ext.forEach(([o, n], i) => {
    const at = [0x1d, 0x39, 0x55][i];
    dv.setUint32(at, o, true);
    dv.setUint32(at + 4, n, true);
  });
  return h;
}

/** levels: [number, bits, inherited, count]; subdivs: [rgnOffset, kinds, cx, cy] in level order;
 *  extRecords: [poly2, line2, point2] offsets (one per subdivision + sentinel). Half-width/height are 10. */
export function makeTre(
  levels: Array<[number, number, boolean, number]>,
  subdivs: Array<[number, number, number, number]>,
  extRecords: Array<[number, number, number]> = [],
  bounds: [number, number, number, number] = [1000, 1000, -1000, -1000],
  hlen = 0xbc,
): Uint8Array {
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN TRE'), 2);
  bounds.forEach((v, i) => h.set(packS24(v), 0x15 + 3 * i));
  const lv = concat(...levels.map(([num, bits, inh, cnt]) => new Uint8Array([num | (inh ? 0x80 : 0), bits, cnt & 0xff, cnt >> 8])));
  const sd: number[] = [];
  let i = 0;
  levels.forEach(([, , , cnt], li) => {
    const last = li === levels.length - 1;
    for (let k = 0; k < cnt; k++) {
      const [rgnOff, kinds, cx, cy] = subdivs[i++];
      sd.push(rgnOff & 0xff, (rgnOff >> 8) & 0xff, (rgnOff >> 16) & 0xff, kinds, ...packS24(cx), ...packS24(cy), 10, 0, 10, 0);
      if (!last) sd.push(0, 0);
    }
  });
  const ext = new Uint8Array(13 * extRecords.length);
  const edv = new DataView(ext.buffer);
  extRecords.forEach(([a, b, c], j) => {
    edv.setUint32(13 * j, a, true);
    edv.setUint32(13 * j + 4, b, true);
    edv.setUint32(13 * j + 8, c, true);
  });
  const lvOff = hlen;
  const sdOff = lvOff + lv.length;
  const extOff = sdOff + sd.length;
  dv.setUint32(0x21, lvOff, true);
  dv.setUint32(0x25, lv.length, true);
  dv.setUint32(0x29, sdOff, true);
  dv.setUint32(0x2d, sd.length, true);
  dv.setUint32(0x7c, extOff, true);
  dv.setUint32(0x80, ext.length, true);
  dv.setUint16(0x84, ext.length ? 13 : 0, true);
  return concat(h, lv, new Uint8Array(sd), ext);
}
```

- [ ] **Step 2: Write the failing tests**

`web/test/tre.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { KIND_LINES, KIND_POINTS, parseTre, shiftOf, subdivisionBounds } from '../src/img/tre';
import { makeRgnHeader, makeTre } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const LEVELS: Array<[number, number, boolean, number]> = [[1, 22, false, 1], [0, 24, false, 2]];

describe('parseTre', () => {
  test('levels, subdivisions and bounds', () => {
    const t = parseTre(makeTre(LEVELS, [[0, KIND_POINTS, 100, 200], [40, KIND_LINES, -5, 7], [90, 0, 1, 2]]), makeRgnHeader(300));
    expect(t.levels.map((l) => [l.number, l.bits])).toEqual([[1, 22], [0, 24]]);
    const s = t.subdivisions;
    expect(s.map((x) => [x.rgnStart, x.rgnEnd])).toEqual([[0x7d, 0x7d + 40], [0x7d + 40, 0x7d + 90], [0x7d + 90, 0x7d + 300]]);
    expect([shiftOf(s[0]), shiftOf(s[1])]).toEqual([2, 0]);
    expect([s[1].cx, s[1].cy, s[1].kinds]).toEqual([-5, 7, KIND_LINES]);
    expect(subdivisionBounds(s[0])).toEqual([60, 160, 140, 240]);
    expect(t.north).toBeCloseTo((1000 * 360) / 2 ** 24, 12);
  });

  test('unwraps 24-bit RGN offsets', () => {
    const s = parseTre(makeTre(LEVELS, [[0, 0, 0, 0], [0xfffff0, 0, 0, 0], [0x10, 0, 0, 0]]), makeRgnHeader(0x1000100)).subdivisions;
    expect(s[2].rgnStart).toBe(0x7d + 0x1000010);
    expect(s[1].rgnEnd).toBe(s[2].rgnStart);
  });

  test('ext offsets', () => {
    const tre = makeTre(LEVELS, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0], [20, 0, 0], [20, 0, 12], [60, 0, 12]]);
    const s = parseTre(tre, makeRgnHeader(10, [[500, 60], [600, 0], [700, 12]])).subdivisions;
    expect(s[0].ext).toEqual([[500, 520], [600, 600], [700, 700]]);
    expect(s[1].ext).toEqual([[520, 520], [600, 600], [700, 712]]);
    expect(s[2].ext).toEqual([[520, 560], [600, 600], [712, 712]]);
  });

  test('locked TRE is rejected', () => {
    const tre = makeTre(LEVELS, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    tre[0x0d] = 0x80;
    expect(() => parseTre(tre, makeRgnHeader(10))).toThrow(/locked/);
  });
});

describe.skipIf(!hasRealData)('parseTre on real data', () => {
  test('tile 14057403', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgnHead = await img.read('14057403.RGN', 0, 0x7d);
    const t = parseTre(await img.read('14057403.TRE'), rgnHead);
    expect(t.levels.map((l) => l.bits)).toEqual([16, 18, 20, 22, 24]);
    expect(t.subdivisions.length).toBe(7892);
    const starts = t.subdivisions.map((s) => s.rgnStart);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(t.subdivisions.at(-1)!.rgnEnd).toBeGreaterThan(2 ** 24);
    expect(t.south).toBeGreaterThan(62.9);
    expect(t.north).toBeLessThan(65.2);
    await src.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run test/tre.test.ts; cd ..`
Expected: FAIL (cannot resolve the module).

- [ ] **Step 4: Implement**

`web/src/img/tre.ts`:
```ts
import { ascii, ImgError, mapUnitsToDeg, s24, u16, u24, u32, u8 } from './bytes';

export const KIND_POINTS = 0x10;
export const KIND_IDX_POINTS = 0x20;
export const KIND_LINES = 0x40;
export const KIND_POLYGONS = 0x80;

export type Range = [number, number];
export const EMPTY_EXT: [Range, Range, Range] = [[0, 0], [0, 0], [0, 0]];

export interface Level {
  number: number;
  bits: number;
  inherited: boolean;
  count: number;
}

export interface Subdivision {
  index: number;
  level: Level;
  kinds: number;
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  rgnStart: number;
  rgnEnd: number;
  ext: [Range, Range, Range];
}

export interface Tre {
  north: number;
  east: number;
  south: number;
  west: number;
  levels: Level[];
  subdivisions: Subdivision[];
}

export const shiftOf = (sd: Subdivision): number => 24 - sd.level.bits;

export const hasData = (sd: Subdivision): boolean => sd.kinds !== 0 || sd.ext.some(([a, e]) => e > a);

/** [west, south, east, north] in Garmin map units. */
export function subdivisionBounds(sd: Subdivision): [number, number, number, number] {
  const k = 2 ** shiftOf(sd);
  return [sd.cx - sd.halfWidth * k, sd.cy - sd.halfHeight * k, sd.cx + sd.halfWidth * k, sd.cy + sd.halfHeight * k];
}

export function parseTre(tre: Uint8Array, rgn: Uint8Array): Tre {
  if (ascii(tre, 2, 12) !== 'GARMIN TRE') throw new ImgError('TRE: bad signature');
  if (ascii(rgn, 2, 12) !== 'GARMIN RGN') throw new ImgError('RGN: bad signature');
  const hlen = u16(tre, 0);
  if (u8(tre, 0x0d) & 0x80) throw new ImgError('TRE is locked/encrypted (header flag 0x80); locked maps are not supported');

  const lo = u32(tre, 0x21);
  const ls = u32(tre, 0x25);
  const levels: Level[] = [];
  for (let i = 0; i < ls; i += 4) {
    levels.push({ number: u8(tre, lo + i) & 0x0f, bits: u8(tre, lo + i + 1), inherited: (u8(tre, lo + i) & 0x80) !== 0, count: u16(tre, lo + i + 2) });
  }

  const rgnOff = u32(rgn, 0x15);
  const rgnLen = u32(rgn, 0x19);
  const subs: Subdivision[] = [];
  let p = u32(tre, 0x29);
  let wrap = 0;
  let prev = -1;
  levels.forEach((level, li) => {
    const rec = li === levels.length - 1 ? 14 : 16;
    for (let k = 0; k < level.count; k++) {
      let r = u24(tre, p) + wrap;
      if (r < prev) {
        // RGN offsets are 24-bit; sections over 16 MB wrap around
        wrap += 0x1000000;
        r += 0x1000000;
      }
      prev = r;
      subs.push({
        index: subs.length, level, kinds: u8(tre, p + 3), cx: s24(tre, p + 4), cy: s24(tre, p + 7),
        halfWidth: u16(tre, p + 10) & 0x7fff, halfHeight: u16(tre, p + 12),
        rgnStart: rgnOff + r, rgnEnd: 0, ext: EMPTY_EXT,
      });
      p += rec;
    }
  });
  for (let i = 0; i + 1 < subs.length; i++) subs[i].rgnEnd = subs[i + 1].rgnStart;
  if (subs.length) subs[subs.length - 1].rgnEnd = rgnOff + rgnLen;
  attachExt(tre, rgn, hlen, subs);

  return {
    north: mapUnitsToDeg(s24(tre, 0x15)), east: mapUnitsToDeg(s24(tre, 0x18)),
    south: mapUnitsToDeg(s24(tre, 0x1b)), west: mapUnitsToDeg(s24(tre, 0x1e)),
    levels, subdivisions: subs,
  };
}

function attachExt(tre: Uint8Array, rgn: Uint8Array, hlen: number, subs: Subdivision[]): void {
  if (hlen < 0x86 || u16(rgn, 0) < 0x5d) return;
  const off = u32(tre, 0x7c);
  const size = u32(tre, 0x80);
  const rec = u16(tre, 0x84);
  if (!size || rec < 12) return;
  const sections: Range[] = [[u32(rgn, 0x1d), u32(rgn, 0x21)], [u32(rgn, 0x39), u32(rgn, 0x3d)], [u32(rgn, 0x55), u32(rgn, 0x59)]];
  const records: Array<[number, number, number]> = [];
  for (let i = 0; i < Math.floor(size / rec); i++) {
    const o = off + i * rec;
    records.push([u32(tre, o), u32(tre, o + 4), rec >= 13 ? u32(tre, o + 8) : 0]);
  }
  subs.slice(0, records.length).forEach((sd, i) => {
    sd.ext = sections.map(([sectOff, sectLen], k) => {
      let start = records[i][k];
      let end = i + 1 < records.length ? records[i + 1][k] : sectLen;
      if (k === 2 && rec < 13) start = end = 0;
      return [sectOff + start, sectOff + end];
    }) as [Range, Range, Range];
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run test/tre.test.ts && npx tsc --noEmit; cd ..`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add web/src/img/tre.ts web/test/tre.test.ts web/test/helpers/builders.ts
git commit -m "Port TRE parser with offset unwrap and subdivision bounds"
```

---

### Task 5: RGN object decoder

**Files:**
- Create: `web/src/img/rgn.ts`, `web/test/rgn.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`, `decodeDeltas`, `Subdivision`, `KIND_*` and `shiftOf`.
- Produces:
  - `interface Chunk { bytes: Uint8Array; base: number }`, where `bytes[i]` is the RGN subfile byte at `base + i`;
  - `interface SubdivisionBytes { main: Chunk; ext: [Chunk, Chunk, Chunk] }`;
  - `type Kind = 'point' | 'line' | 'polygon'`;
  - `interface RawObject { kind; type; label; labelSrc: 'lbl' | 'poi' | 'net'; coords: Array<[number, number]> }` (coordinates in map units);
  - `interface DecodeStats { sections: number; badSections: number }`;
  - `decodeSubdivision(bytes: SubdivisionBytes, sd: Subdivision, stats: DecodeStats): RawObject[]`.

- [ ] **Step 1: Write the failing tests** (the same fixtures as the Python `tests/test_rgn.py`)

`web/test/rgn.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { decodeSubdivision, type Chunk, type DecodeStats } from '../src/img/rgn';
import { EMPTY_EXT, KIND_LINES, KIND_POINTS, parseTre, type Range, type Subdivision } from '../src/img/tre';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const LEVEL24 = { number: 0, bits: 24, inherited: false, count: 1 };
const sub = (start: number, end: number, kinds: number, ext: [Range, Range, Range] = EMPTY_EXT): Subdivision => ({
  index: 0, level: LEVEL24, kinds, cx: 1000, cy: 2000, halfWidth: 0, halfHeight: 0, rgnStart: start, rgnEnd: end, ext,
});
const whole = (bytes: number[] | Uint8Array) => {
  const c: Chunk = { bytes: Uint8Array.from(bytes), base: 0 };
  return { main: c, ext: [c, c, c] as [Chunk, Chunk, Chunk] };
};
const stats = (): DecodeStats => ({ sections: 0, badSections: 0 });

describe('decodeSubdivision', () => {
  test('points and lines with a section pointer', () => {
    const point = [0x2f, 0x05, 0x00, 0x80, 0x01, 0x00, 0xff, 0xff, 0x06];
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const body = [2 + point.length, 0, ...point, ...line];
    const s = stats();
    const objs = decodeSubdivision(whole([...new Array(10).fill(0), ...body]), sub(10, 10 + body.length, KIND_POINTS | KIND_LINES), s);
    expect(objs.map((o) => [o.kind, o.type, o.label, o.labelSrc, o.coords])).toEqual([
      ['point', 0x2f06, 5, 'lbl', [[1001, 1999]]],
      ['line', 0x16, 0, 'lbl', [[1000, 2000], [1001, 2002]]],
    ]);
    expect(s).toEqual({ sections: 2, badSections: 0 });
  });

  test('extended polygon with label', () => {
    const rec = [0x03, 0x21, 0x02, 0x00, 0x03, 0x00, 0x07, 0x00, 0x25, 0x01, 0x07, 0x00, 0x00];
    const s = stats();
    const objs = decodeSubdivision(whole([0, 0, 0, 0, ...rec]), sub(0, 0, 0, [[4, 4 + rec.length], [0, 0], [0, 0]]), s);
    expect(objs.map((o) => [o.kind, o.type, o.label, o.coords])).toEqual([['polygon', 0x10301, 7, [[1002, 2003], [1003, 2005]]]]);
    expect(s.badSections).toBe(0);
  });

  test('extended point with POI label', () => {
    const rec = [0x2c, 0x25, 0x01, 0x00, 0x02, 0x00, 0x09, 0x00, 0x40];
    const objs = decodeSubdivision(whole(rec), sub(0, 0, 0, [[0, 0], [0, 0], [0, rec.length]]), stats());
    expect(objs.map((o) => [o.kind, o.type, o.label, o.labelSrc, o.coords])).toEqual([['point', 0x12c05, 9, 'poi', [[1001, 2002]]]]);
  });

  test('a misaligned section contributes no objects', () => {
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const s = stats();
    const objs = decodeSubdivision(whole([...line, 0]), sub(0, line.length + 1, KIND_LINES), s);
    expect(objs).toEqual([]);
    expect(s.badSections).toBe(1);
  });

  test('chunks with a non-zero base address absolute offsets', () => {
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const c: Chunk = { bytes: Uint8Array.from(line), base: 5000 };
    const objs = decodeSubdivision({ main: c, ext: [c, c, c] }, sub(5000, 5000 + line.length, KIND_LINES), stats());
    expect(objs.length).toBe(1);
  });
});

describe.skipIf(!hasRealData)('decodeSubdivision on real data', () => {
  test('tile 14057403 sections align (head and past the 16 MB wrap)', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgn = await img.read('14057403.RGN');
    const t = parseTre(await img.read('14057403.TRE'), rgn.subarray(0, 0x7d));
    const c: Chunk = { bytes: rgn, base: 0 };
    const s = stats();
    let latOk = true;
    for (const sd of [...t.subdivisions.slice(0, 1500), ...t.subdivisions.slice(-800)]) {
      for (const o of decodeSubdivision({ main: c, ext: [c, c, c] }, sd, s)) {
        latOk &&= o.coords.every(([, y]) => (y * 360) / 2 ** 24 > 62.9 && (y * 360) / 2 ** 24 < 65.2);
      }
    }
    expect(s.sections).toBeGreaterThan(1000);
    expect(s.badSections).toBe(0);
    expect(latOk).toBe(true);
    await src.close();
  }, 120_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/rgn.test.ts; cd ..`
Expected: FAIL (cannot resolve the module).

- [ ] **Step 3: Implement**

`web/src/img/rgn.ts`:
```ts
import { decodeDeltas } from './bitstream';
import { s16, u16, u24, u8 } from './bytes';
import { KIND_IDX_POINTS, KIND_LINES, KIND_POINTS, KIND_POLYGONS, shiftOf, type Subdivision } from './tre';

export interface Chunk {
  bytes: Uint8Array;
  base: number;
}

export interface SubdivisionBytes {
  main: Chunk;
  ext: [Chunk, Chunk, Chunk];
}

export type Kind = 'point' | 'line' | 'polygon';
export type LabelSrc = 'lbl' | 'poi' | 'net';

export interface RawObject {
  kind: Kind;
  type: number;
  label: number;
  labelSrc: LabelSrc;
  coords: Array<[number, number]>;
}

export interface DecodeStats {
  sections: number;
  badSections: number;
}

const b8 = (c: Chunk, o: number) => u8(c.bytes, o - c.base);
const b16 = (c: Chunk, o: number) => u16(c.bytes, o - c.base);
const bs16 = (c: Chunk, o: number) => s16(c.bytes, o - c.base);
const b24 = (c: Chunk, o: number) => u24(c.bytes, o - c.base);

function bitstream(c: Chunk, p: number, n: number): Uint8Array {
  const start = p - c.base;
  if (n < 0 || start < 0 || start + n > c.bytes.length) throw new RangeError('bitstream runs past the end of RGN');
  return c.bytes.subarray(start, start + n);
}

function walk(sd: Subdivision, dx: number, dy: number, deltas: Array<[number, number]>): Array<[number, number]> {
  const k = 2 ** shiftOf(sd);
  let x = sd.cx + dx * k;
  let y = sd.cy + dy * k;
  const coords: Array<[number, number]> = [[x, y]];
  for (const [ddx, ddy] of deltas) {
    if (ddx === 0 && ddy === 0) continue;
    x += ddx * k;
    y += ddy * k;
    coords.push([x, y]);
  }
  return coords;
}

type Decoded = [number, RawObject];

function point(c: Chunk, o: number, sd: Subdivision): Decoded {
  const k = 2 ** shiftOf(sd);
  const lb = b24(c, o + 1);
  const x = sd.cx + bs16(c, o + 4) * k;
  const y = sd.cy + bs16(c, o + 6) * k;
  let size = 8;
  let sub = 0;
  if (lb & 0x800000) {
    sub = b8(c, o + 8);
    size = 9;
  }
  return [size, { kind: 'point', type: (b8(c, o) << 8) | sub, label: lb & 0x3fffff, labelSrc: lb & 0x400000 ? 'poi' : 'lbl', coords: [[x, y]] }];
}

function poly(c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
  const t = b8(c, o);
  const type = line ? t & 0x3f : t & 0x7f;
  const lb = b24(c, o + 1);
  const dx = bs16(c, o + 4);
  const dy = bs16(c, o + 6);
  let n: number;
  let p: number;
  if (t & 0x80) {
    n = b16(c, o + 8);
    p = o + 10;
  } else {
    n = b8(c, o + 8);
    p = o + 9;
  }
  const info = b8(c, p);
  p += 1;
  const deltas = decodeDeltas(bitstream(c, p, n), info, false, (lb & 0x400000) !== 0);
  return [p + n - o, { kind: line ? 'line' : 'polygon', type, label: lb & 0x3fffff, labelSrc: lb & 0x800000 ? 'net' : 'lbl', coords: walk(sd, dx, dy, deltas) }];
}

function poly2(c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
  const t = b8(c, o);
  const st = b8(c, o + 1);
  const dx = bs16(c, o + 2);
  const dy = bs16(c, o + 4);
  let p = o + 6;
  let n: number;
  if ((b8(c, p) & 1) === 0) {
    n = (b16(c, p) >> 2) - 1;
    p += 2;
  } else {
    n = (b8(c, p) >> 1) - 1;
    p += 1;
  }
  const info = b8(c, p);
  p += 1;
  const deltas = decodeDeltas(bitstream(c, p, n), info, true, false);
  p += n;
  let label = 0;
  if (st & 0x20) {
    label = b24(c, p) & 0x3fffff;
    p += 3;
  }
  const type = 0x10000 | (t << 8) | (st & 0x1f);
  return [p - o, { kind: line ? 'line' : 'polygon', type, label, labelSrc: 'lbl', coords: walk(sd, dx, dy, deltas) }];
}

function point2(c: Chunk, o: number, sd: Subdivision): Decoded {
  const k = 2 ** shiftOf(sd);
  const t = b8(c, o);
  const st = b8(c, o + 1);
  const x = sd.cx + bs16(c, o + 2) * k;
  const y = sd.cy + bs16(c, o + 4) * k;
  let size = 6;
  let label = 0;
  let labelSrc: LabelSrc = 'lbl';
  if (st & 0x20) {
    const lb = b24(c, o + 6);
    label = lb & 0x3fffff;
    labelSrc = lb & 0x400000 ? 'poi' : 'lbl';
    size += 3;
  }
  if (st & 0x80) size += 1;
  return [size, { kind: 'point', type: 0x10000 | (t << 8) | (st & 0x1f), label, labelSrc, coords: [[x, y]] }];
}

function run(stats: DecodeStats, out: RawObject[], start: number, end: number, decodeOne: (o: number) => Decoded): void {
  stats.sections += 1;
  const local: RawObject[] = [];
  let o = start;
  try {
    while (o < end) {
      const [size, obj] = decodeOne(o);
      o += size;
      local.push(obj);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    stats.badSections += 1;
    return;
  }
  if (o !== end) {
    stats.badSections += 1;
    return;
  }
  out.push(...local);
}

const SECTIONS = [KIND_POINTS, KIND_IDX_POINTS, KIND_LINES, KIND_POLYGONS];

export function decodeSubdivision(bytes: SubdivisionBytes, sd: Subdivision, stats: DecodeStats): RawObject[] {
  const out: RawObject[] = [];
  const c = bytes.main;
  const present = SECTIONS.filter((k) => sd.kinds & k);
  if (present.length && sd.rgnEnd > sd.rgnStart) {
    const starts = [sd.rgnStart + 2 * (present.length - 1)];
    for (let i = 0; i < present.length - 1; i++) starts.push(sd.rgnStart + b16(c, sd.rgnStart + 2 * i));
    const ends = [...starts.slice(1), sd.rgnEnd];
    present.forEach((kind, i) => {
      if (kind === KIND_POINTS || kind === KIND_IDX_POINTS) run(stats, out, starts[i], ends[i], (o) => point(c, o, sd));
      else run(stats, out, starts[i], ends[i], (o) => poly(c, o, sd, kind === KIND_LINES));
    });
  }
  const [[pgA, pgE], [lnA, lnE], [ptA, ptE]] = sd.ext;
  if (pgE > pgA) run(stats, out, pgA, pgE, (o) => poly2(bytes.ext[0], o, sd, false));
  if (lnE > lnA) run(stats, out, lnA, lnE, (o) => poly2(bytes.ext[1], o, sd, true));
  if (ptE > ptA) run(stats, out, ptA, ptE, (o) => point2(bytes.ext[2], o, sd));
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/rgn.test.ts && npx tsc --noEmit; cd ..`
Expected: 6 passed. If the real-data test fails, compare against `imgconv/rgn.py`, which is verified. Do not change the fixtures.

- [ ] **Step 5: Commit**

```bash
git add web/src/img/rgn.ts web/test/rgn.test.ts
git commit -m "Port RGN object decoder over byte chunks"
```

---

### Task 6: Labels, zoom bands and contour labels

**Files:**
- Create: `web/src/img/lbl.ts`, `web/src/map/zoom.ts`, `web/test/lbl.test.ts`, `web/test/zoom.test.ts`

**Interfaces:**
- Consumes: `bytes.ts` and `LabelSrc`.
- Produces:
  - `pyRound(x): number` (round half to even);
  - `formatLabel(raw: Uint8Array, decoder: TextDecoder): string | null`;
  - `class LabelTable(lbl: Uint8Array, net: Uint8Array | null)`, with `.text(label: number, src: LabelSrc): string | null`;
  - `zoomBands(bits: number[]): Map<number, [number, number]>`;
  - `contourLabel(name): string`;
  - `MIN_ZOOM = 4`, `MAX_ZOOM = 14`, `CONTOUR_LINE_TYPES: Set<number>` (0x20–0x25).

- [ ] **Step 1: Write the failing tests**

`web/test/zoom.test.ts`:
```ts
import { expect, test } from 'vitest';
import { contourLabel, pyRound, zoomBands } from '../src/map/zoom';

test('zoom bands start the coarsest level at 4', () => {
  expect([...zoomBands([18, 20, 22, 24, 24, 20])]).toEqual([[18, [4, 8]], [20, [9, 10]], [22, [11, 12]], [24, [13, 14]]]);
  expect([...zoomBands([24])]).toEqual([[24, [4, 14]]]);
});

test('python-style rounding and contour labels', () => {
  expect([pyRound(2.5), pyRound(3.5), pyRound(-2.5), pyRound(1491.08)]).toEqual([2, 4, -2, 1491]);
  expect(contourLabel('328')).toBe('100');
  expect(contourLabel('Hekla')).toBe('Hekla');
});
```

`web/test/lbl.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { formatLabel, LabelTable } from '../src/img/lbl';
import { decodeSubdivision, type Chunk } from '../src/img/rgn';
import { parseTre } from '../src/img/tre';
import { bytesOf, concat } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const cp1252 = new TextDecoder('windows-1252');

function makeLbl(strings: Uint8Array[], encoding = 9, poi = new Uint8Array(0)): Uint8Array {
  const hlen = 0xac;
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN LBL'), 2);
  const data = concat(new Uint8Array([0]), ...strings.map((s) => concat(s, new Uint8Array([0]))));
  dv.setUint32(0x15, hlen, true);
  dv.setUint32(0x19, data.length, true);
  h[0x1e] = encoding;
  dv.setUint32(0x57, hlen + data.length, true);
  dv.setUint32(0x5b, poi.length, true);
  dv.setUint16(0xaa, 1252, true);
  return concat(h, data, poi);
}

describe('formatLabel', () => {
  test('icelandic codepage', () => expect(formatLabel(new Uint8Array([0x47, 0xf6, 0x6e, 0x67, 0x75, 0x73, 0x6b, 0x61, 0x72, 0xf0]), cp1252)).toBe('Gönguskarð'));
  test('elevation suffix in feet becomes metres', () => expect(formatLabel(concat(bytesOf('HEKLA'), new Uint8Array([0x1f]), bytesOf('4892')), cp1252)).toBe('HEKLA 1491 m'));
  test('elevation followed by another separator', () =>
    expect(formatLabel(concat(bytesOf('A'), new Uint8Array([0x1f]), bytesOf('4892'), new Uint8Array([0x1b]), bytesOf('XYZ')), cp1252)).toBe('A 1491 m XYZ'));
  test('control bytes are dropped', () => expect(formatLabel(new Uint8Array([0x01, 0x41, 0x1b, 0x42]), cp1252)).toBe('A B'));
});

describe('LabelTable', () => {
  test('lookup by offset and POI', () => {
    const table = new LabelTable(makeLbl([bytesOf('Vatn'), bytesOf('Hraun')], 9, new Uint8Array([6, 0, 0])), null);
    expect(table.text(1, 'lbl')).toBe('Vatn');
    expect(table.text(6, 'lbl')).toBe('Hraun');
    expect(table.text(0, 'lbl')).toBeNull();
    expect(table.text(0, 'poi')).toBe('Hraun');
  });

  test('NET label', () => {
    const net = new Uint8Array(0x20 + 3);
    net.set(bytesOf('GARMIN NET'), 2);
    new DataView(net.buffer).setUint32(0x15, 0x20, true);
    net.set([1, 0, 0x80], 0x20);
    expect(new LabelTable(makeLbl([bytesOf('Hringvegur')]), net).text(0, 'net')).toBe('Hringvegur');
  });

  test('unsupported encoding', () => expect(() => new LabelTable(makeLbl([bytesOf('X')], 6), null)).toThrow(/encoding 6/));
});

describe.skipIf(!hasRealData)('labels on real data', () => {
  test('names from tile 14057403', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgn = await img.read('14057403.RGN');
    const t = parseTre(await img.read('14057403.TRE'), rgn.subarray(0, 0x7d));
    const table = new LabelTable(await img.read('14057403.LBL'), await img.read('14057403.NET'));
    const c: Chunk = { bytes: rgn, base: 0 };
    const names = new Set<string>();
    for (const sd of t.subdivisions.slice(938, 1400)) {
      for (const o of decodeSubdivision({ main: c, ext: [c, c, c] }, sd, { sections: 0, badSections: 0 })) {
        const n = table.text(o.label, o.labelSrc);
        if (n) names.add(n);
      }
    }
    expect(names.has('Gönguskarð')).toBe(true);
    expect(names.has('Drífandi')).toBe(true);
    await src.close();
  }, 120_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/lbl.test.ts test/zoom.test.ts; cd ..`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

`web/src/map/zoom.ts`:
```ts
export const ZOOM_OFFSET = 11;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 14;
export const CONTOUR_LINE_TYPES = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);

/** Python's round(): halves go to the nearest even integer. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** Map level resolution (bits) to a [minzoom, maxzoom] band in MapLibre zoom. */
export function zoomBands(bits: number[]): Map<number, [number, number]> {
  const levels = [...new Set(bits)].sort((a, b) => a - b);
  const starts = [MIN_ZOOM, ...levels.slice(1).map((b) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b - ZOOM_OFFSET)))];
  const bands = new Map<number, [number, number]>();
  levels.forEach((b, i) => {
    const end = i + 1 < levels.length ? starts[i + 1] - 1 : MAX_ZOOM;
    if (end >= starts[i]) bands.set(b, [starts[i], end]);
  });
  return bands;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function isNumber(s: string): boolean {
  return NUMBER.test(s.trim());
}

export function contourLabel(name: string): string {
  return isNumber(name) ? String(pyRound(parseFloat(name) * 0.3048)) : name;
}
```

`web/src/img/lbl.ts`:
```ts
import { isNumber, pyRound } from '../map/zoom';
import { ascii, ImgError, u16, u24, u32, u8 } from './bytes';
import type { LabelSrc } from './rgn';

const FEET_TO_M = 0.3048;
const ELEVATION_SEPARATOR = 0x1f;

export function formatLabel(raw: Uint8Array, decoder: TextDecoder): string | null {
  const parts: Array<[number[], number]> = [];
  let buf: number[] = [];
  let prevSep = 0;
  for (const b of raw) {
    if (b >= 0x1b && b <= 0x1f) {
      if (buf.length) {
        parts.push([buf, prevSep]);
        buf = [];
      }
      prevSep = b;
    } else if (b >= 0x07) {
      buf.push(b);
    }
  }
  if (buf.length) parts.push([buf, prevSep]);
  const out: string[] = [];
  for (const [bytes, sep] of parts) {
    let s = decoder.decode(new Uint8Array(bytes)).trim();
    if (sep === ELEVATION_SEPARATOR && isNumber(s)) s = `${pyRound(parseFloat(s) * FEET_TO_M)} m`;
    if (s) out.push(s);
  }
  return out.length ? out.join(' ') : null;
}

function decoderFor(codepage: number): TextDecoder {
  const label = codepage === 65001 ? 'utf-8' : codepage ? `windows-${codepage}` : 'windows-1252';
  try {
    return new TextDecoder(label);
  } catch {
    throw new ImgError(`LBL: codepage ${codepage} not supported`);
  }
}

export class LabelTable {
  private readonly lbl1: number;
  private readonly shift: number;
  private readonly decoder: TextDecoder;
  private readonly poiOff: number;
  private readonly poiShift: number;
  private readonly net1: number;
  private readonly netShift: number;
  private readonly cache = new Map<number, string | null>();

  constructor(private readonly lbl: Uint8Array, private readonly net: Uint8Array | null) {
    if (ascii(lbl, 2, 12) !== 'GARMIN LBL') throw new ImgError('LBL: bad signature');
    const encoding = u8(lbl, 0x1e);
    if (encoding !== 9) throw new ImgError(`LBL: label encoding ${encoding} not supported (only 8-bit labels, encoding 9)`);
    this.lbl1 = u32(lbl, 0x15);
    this.shift = u8(lbl, 0x1d);
    this.decoder = decoderFor(u16(lbl, 0) >= 0xac ? u16(lbl, 0xaa) : 1252);
    this.poiOff = u32(lbl, 0x57);
    this.poiShift = u8(lbl, 0x5f);
    this.net1 = net ? u32(net, 0x15) : 0;
    this.netShift = net ? u8(net, 0x1d) : 0;
  }

  text(label: number, src: LabelSrc): string | null {
    if (src === 'lbl' && label === 0) return null;
    try {
      const off = this.resolve(label, src);
      if (!off) return null;
      let v = this.cache.get(off);
      if (v === undefined) {
        const start = this.lbl1 + off * 2 ** this.shift;
        let end = this.lbl.indexOf(0, start);
        if (end < 0) end = this.lbl.length;
        v = formatLabel(this.lbl.subarray(start, end), this.decoder);
        this.cache.set(off, v);
      }
      return v;
    } catch (err) {
      if (err instanceof RangeError) return null;
      throw err;
    }
  }

  private resolve(label: number, src: LabelSrc): number | null {
    if (src === 'poi') return u24(this.lbl, this.poiOff + label * 2 ** this.poiShift) & 0x3fffff;
    if (src === 'net') {
      if (!this.net) return null;
      const v = u24(this.net, this.net1 + label * 2 ** this.netShift);
      return v & 0x400000 ? null : v & 0x3fffff;
    }
    return label;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/lbl.test.ts test/zoom.test.ts && npx tsc --noEmit; cd ..`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/img/lbl.ts web/src/map/zoom.ts web/test/lbl.test.ts web/test/zoom.test.ts
git commit -m "Port labels, zoom bands and contour label conversion"
```

---

### Task 7: GarminMap and a golden cross-check against the Python decoder

**Files:**
- Create: `web/src/map/garminMap.ts`, `web/src/map/decodeAll.ts`, `web/test/golden.test.ts`

**Interfaces:**
- Consumes: `ImgContainer`, `parseTre`, `hasData`, `LabelTable`, `decodeSubdivision`, `zoomBands`, `contourLabel` and `CONTOUR_LINE_TYPES`.
- Produces:
  - `interface MapTile { id: string; tre: Tre; labels: LabelTable; byLevel: Map<number, Subdivision[]> }`, where `byLevel` holds only subdivisions that have data;
  - `class GarminMap`, with:
    - `static open(src: ByteSource): Promise<GarminMap>`, which raises tile-named `ImgError`s;
    - `tiles: MapTile[]`, `bands: Map<number, [number, number]>`, `bounds: [w, s, e, n]` in degrees, and `typ: Uint8Array | null`;
    - `levelForZoom(z): number | undefined`;
    - `readSubdivision(tile, sd): Promise<SubdivisionBytes>`.
  - `objectName(tile, obj): string | null`, which applies the contour conversion;
  - `decodeAll(map, visit: (tile, sd, obj) => void | false): Promise<DecodeStats>`, which visits in tile, subdivision and object order and stops when `visit` returns `false`.

- [ ] **Step 1: Write the failing golden test**

`web/test/golden.test.ts`:
```ts
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mapUnitsToDeg } from '../src/img/bytes';
import type { RawObject } from '../src/img/rgn';
import { decodeAll } from '../src/map/decodeAll';
import { GarminMap, objectName } from '../src/map/garminMap';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData, PY_OUT } from './helpers/paths';

const LAYER = { point: 'points', line: 'lines', polygon: 'polygons' } as const;
const ICELAND = [-26.5, 62.5, -11.5, 67.5];
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Same filtering and geometry as imgconv/features.py: to_feature + in_bounds. */
function pyLike(obj: RawObject): number[][] | null {
  const coords = obj.coords.map(([x, y]) => [mapUnitsToDeg(x), mapUnitsToDeg(y)]);
  if (obj.kind === 'line' && coords.length < 2) return null;
  if (obj.kind === 'polygon') {
    if (coords.length < 3) return null;
    const [f, l] = [coords[0], coords[coords.length - 1]];
    if (r6(f[0]) !== r6(l[0]) || r6(f[1]) !== r6(l[1])) coords.push(f);
  }
  const [w, s, e, n] = ICELAND;
  return coords.every(([x, y]) => x >= w && x <= e && y >= s && y <= n) ? coords : null;
}

const ready = hasRealData && existsSync(PY_OUT + 'types.json') && existsSync(PY_OUT + 'features.geojsonseq');

describe.skipIf(!ready)('golden: TypeScript decoder vs Python imgconv', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
  }, 60_000);
  afterAll(() => src.close());

  test('map metadata', () => {
    expect(map.tiles.map((t) => t.id)).toEqual(['14057401', '14057402', '14057403', '14057405', '14057406']);
    expect([...map.bands]).toEqual([[18, [4, 8]], [20, [9, 10]], [22, [11, 12]], [24, [13, 14]]]);
    expect(map.levelForZoom(13)).toBe(24);
    expect(map.typ).not.toBeNull();
  });

  test('section stats and per-type counts match', async () => {
    const counts: Record<string, Record<string, number>> = { points: {}, lines: {}, polygons: {} };
    const stats = await decodeAll(map, (_tile, _sd, obj) => {
      if (!pyLike(obj)) return;
      const layer = counts[LAYER[obj.kind]];
      layer[obj.type] = (layer[obj.type] ?? 0) + 1;
    });
    const pyStats = JSON.parse(readFileSync(PY_OUT + 'decode-stats.json', 'utf8'));
    const pyTypes = JSON.parse(readFileSync(PY_OUT + 'types.json', 'utf8'));
    expect(stats.sections).toBe(pyStats.sections);
    expect(stats.badSections).toBe(pyStats.bad_sections);
    for (const layer of ['points', 'lines', 'polygons']) expect(counts[layer]).toEqual(pyTypes[layer]);
  }, 600_000);

  test('first 5000 features match exactly (order, type, name, coordinates)', async () => {
    const ours: Array<{ t: number; name?: string; coords: number[][] }> = [];
    await decodeAll(map, (tile, _sd, obj) => {
      const coords = pyLike(obj);
      if (!coords) return;
      const name = objectName(tile, obj);
      ours.push({ t: obj.type, ...(name ? { name } : {}), coords });
      return ours.length < 5000 ? undefined : false;
    });
    const rl = createInterface({ input: createReadStream(PY_OUT + 'features.geojsonseq') });
    let i = 0;
    for await (const line of rl) {
      if (i >= ours.length) break;
      const f = JSON.parse(line);
      const g = f.geometry;
      const pyCoords: number[][] = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates[0];
      expect({ t: ours[i].t, name: ours[i].name }).toEqual({ t: f.properties.t, name: f.properties.name });
      expect(ours[i].coords.length).toBe(pyCoords.length);
      ours[i].coords.forEach(([x, y], k) => {
        expect(Math.abs(x - pyCoords[k][0])).toBeLessThan(1e-6);
        expect(Math.abs(y - pyCoords[k][1])).toBeLessThan(1e-6);
      });
      i++;
    }
    rl.close();
    expect(i).toBe(5000);
  }, 300_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/golden.test.ts; cd ..`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

`web/src/map/garminMap.ts`:
```ts
import { ImgError, u16 } from '../img/bytes';
import { ImgContainer } from '../img/container';
import { LabelTable } from '../img/lbl';
import type { Chunk, RawObject, SubdivisionBytes } from '../img/rgn';
import type { ByteSource } from '../img/source';
import { hasData, parseTre, type Subdivision, type Tre } from '../img/tre';
import { CONTOUR_LINE_TYPES, contourLabel, zoomBands } from './zoom';

export interface MapTile {
  id: string;
  tre: Tre;
  labels: LabelTable;
  byLevel: Map<number, Subdivision[]>;
}

function named(name: string, err: unknown): Error {
  if (err instanceof ImgError) return new ImgError(`${name}: ${err.message}`);
  if (err instanceof RangeError) return new ImgError(`${name}: truncated or corrupt (${err.message})`);
  return err as Error;
}

export function objectName(tile: MapTile, obj: RawObject): string | null {
  const name = tile.labels.text(obj.label, obj.labelSrc);
  return name && obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type) ? contourLabel(name) : name;
}

export class GarminMap {
  private constructor(
    private readonly img: ImgContainer,
    readonly tiles: MapTile[],
    readonly bands: Map<number, [number, number]>,
    readonly bounds: [number, number, number, number],
    readonly typ: Uint8Array | null,
  ) {}

  static async open(src: ByteSource): Promise<GarminMap> {
    const img = await ImgContainer.open(src);
    const ids = img.tileIds();
    if (ids.length === 0) throw new ImgError('no map tiles (TRE subfiles) in IMG');
    const tiles: MapTile[] = [];
    for (const id of ids) {
      for (const ext of ['TRE', 'RGN', 'LBL']) if (!img.has(`${id}.${ext}`)) throw new ImgError(`${id}: missing ${ext} subfile`);
      let tre: Tre;
      try {
        const rgnName = `${id}.RGN`;
        const hlen = u16(await img.read(rgnName, 0, 2), 0);
        tre = parseTre(await img.read(`${id}.TRE`), await img.read(rgnName, 0, hlen));
      } catch (err) {
        throw named(`${id}.TRE`, err);
      }
      let labels: LabelTable;
      try {
        labels = new LabelTable(await img.read(`${id}.LBL`), img.has(`${id}.NET`) ? await img.read(`${id}.NET`) : null);
      } catch (err) {
        throw named(`${id}.LBL`, err);
      }
      const byLevel = new Map<number, Subdivision[]>();
      for (const sd of tre.subdivisions) {
        if (!hasData(sd)) continue;
        const list = byLevel.get(sd.level.bits) ?? [];
        list.push(sd);
        byLevel.set(sd.level.bits, list);
      }
      tiles.push({ id, tre, labels, byLevel });
    }
    const bands = zoomBands(tiles.flatMap((t) => [...t.byLevel.keys()]));
    const bounds: [number, number, number, number] = [
      Math.min(...tiles.map((t) => t.tre.west)), Math.min(...tiles.map((t) => t.tre.south)),
      Math.max(...tiles.map((t) => t.tre.east)), Math.max(...tiles.map((t) => t.tre.north)),
    ];
    const typName = img.firstOfType('TYP');
    return new GarminMap(img, tiles, bands, bounds, typName ? await img.read(typName) : null);
  }

  levelForZoom(z: number): number | undefined {
    for (const [bits, [a, b]] of this.bands) if (z >= a && z <= b) return bits;
    return undefined;
  }

  async readSubdivision(tile: MapTile, sd: Subdivision): Promise<SubdivisionBytes> {
    const rgn = `${tile.id}.RGN`;
    const chunk = async (a: number, e: number): Promise<Chunk> => ({ bytes: e > a ? await this.img.read(rgn, a, e - a) : new Uint8Array(0), base: a });
    const [main, pg, ln, pt] = await Promise.all([chunk(sd.rgnStart, sd.rgnEnd), ...sd.ext.map(([a, e]) => chunk(a, e))]);
    return { main, ext: [pg, ln, pt] };
  }
}
```

`web/src/map/decodeAll.ts`:
```ts
import { decodeSubdivision, type DecodeStats, type RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import type { GarminMap, MapTile } from './garminMap';

/** Visit every object of every subdivision that has data at a level with a zoom band, in file order. */
export async function decodeAll(
  map: GarminMap,
  visit: (tile: MapTile, sd: Subdivision, obj: RawObject) => void | false,
): Promise<DecodeStats> {
  const stats: DecodeStats = { sections: 0, badSections: 0 };
  for (const tile of map.tiles) {
    const wanted = new Set([...tile.byLevel].filter(([bits]) => map.bands.has(bits)).flatMap(([, sds]) => sds));
    for (const sd of tile.tre.subdivisions) {
      if (!wanted.has(sd)) continue;
      for (const obj of decodeSubdivision(await map.readSubdivision(tile, sd), sd, stats)) {
        if (visit(tile, sd, obj) === false) return stats;
      }
    }
  }
  return stats;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/golden.test.ts && npx tsc --noEmit; cd ..`
Expected: 3 passed. The count test compares with `types.json` for all of about 2M features and runs for a while; record its wall time in the report. **A mismatch is a real bug in the port: fix the port, never the expectations.** Diff the first differing feature against `imgconv/*.py` to find it.

- [ ] **Step 5: Commit**

```bash
git add web/src/map/garminMap.ts web/src/map/decodeAll.ts web/test/golden.test.ts
git commit -m "Add GarminMap and golden cross-check against the Python decoder"
```

---

### Task 8: On-the-fly vector tile builder

**Files:**
- Create: `web/src/tiles/tileMath.ts`, `web/src/tiles/buildTile.ts`, `web/test/tiles.test.ts`

**Interfaces:**
- Consumes: `GarminMap`, `MapTile`, `objectName`, `decodeSubdivision` and `subdivisionBounds`.
- Produces:
  - `EXTENT = 4096` and `BUFFER = 64`;
  - `lonToTileX(lon, z)`, `latToTileY(lat, z)` and `tileBounds(z, x, y): [w, s, e, n]`;
  - `class SubdivisionCache(max)`;
  - `buildTile(map, cache, z, x, y): Promise<{ data: Uint8Array; badSections: number; features: number }>`, which returns an MVT with layers `points`, `lines` and `polygons` and properties `t` and `name`.

- [ ] **Step 1: Write the failing tests**

`web/test/tiles.test.ts`:
```ts
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GarminMap } from '../src/map/garminMap';
import { buildTile, SubdivisionCache } from '../src/tiles/buildTile';
import { latToTileY, lonToTileX, tileBounds } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

describe('tile math', () => {
  test('world tile and round trip', () => {
    const [w, s, e, n] = tileBounds(0, 0, 0);
    expect([w, e]).toEqual([-180, 180]);
    expect(n).toBeCloseTo(85.0511, 3);
    expect(s).toBeCloseTo(-85.0511, 3);
    const [tw, ts] = tileBounds(15, 14387, 7890);
    expect(lonToTileX(tw + 1e-9, 15)).toBe(14387);
    expect(latToTileY(ts + 1e-9, 15)).toBe(7890);
  });
});

function decode(data: Uint8Array) {
  const vt = new VectorTile(new PbfReader(data));
  const out: Array<{ layer: string; name?: string; t: number; geom: Array<Array<{ x: number; y: number }>> }> = [];
  for (const layer of Object.keys(vt.layers)) {
    const l = vt.layers[layer];
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      out.push({ layer, name: f.properties.name as string | undefined, t: f.properties.t as number, geom: f.loadGeometry() });
    }
  }
  return out;
}

describe.skipIf(!hasRealData)('buildTile on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
  }, 60_000);
  afterAll(() => src.close());

  test('Tjörnin tile at z14 has the lake name and clipped geometry', async () => {
    const z = 14;
    const [x, y] = [lonToTileX(-21.9416, z), latToTileY(64.1445, z)];
    const { data, badSections } = await buildTile(map, new SubdivisionCache(500), z, x, y);
    const feats = decode(data);
    expect(badSections).toBe(0);
    expect(feats.length).toBeGreaterThan(100);
    expect(feats.some((f) => f.name?.toLowerCase() === 'tjörnin')).toBe(true);
    for (const f of feats) for (const ring of f.geom) for (const p of ring) {
      expect(p.x).toBeGreaterThanOrEqual(-64);
      expect(p.x).toBeLessThanOrEqual(4160);
      expect(p.y).toBeGreaterThanOrEqual(-64);
      expect(p.y).toBeLessThanOrEqual(4160);
    }
  });

  test('a tile far out at sea is empty', async () => {
    const z = 10;
    const { features } = await buildTile(map, new SubdivisionCache(10), z, lonToTileX(-30, z), latToTileY(60, z));
    expect(features).toBe(0);
  });

  test('timings (spike measurement)', async () => {
    const cache = new SubdivisionCache(1500);
    const around = (lon: number, lat: number, z: number) => {
      const [cx, cy] = [lonToTileX(lon, z), latToTileY(lat, z)];
      return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [z, cx + dx, cy + dy] as const));
    };
    const cases: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
      'Reykjavík z14': around(-21.94, 64.146, 14),
      'Reykjavík z12': around(-21.94, 64.146, 12),
      'Landmannalaugar z13': around(-19.06, 63.99, 13),
      'Vatnajökull z10': around(-16.9, 64.02, 10),
      'Iceland z6': around(-18.6, 64.9, 6),
    };
    const rows: string[] = [];
    for (const [label, tiles] of Object.entries(cases)) {
      const ms: number[] = [];
      for (const [z, x, y] of tiles) {
        const t0 = performance.now();
        await buildTile(map, cache, z, x, y);
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      rows.push(`${label.padEnd(22)} first ${ms[0].toFixed(0).padStart(5)}  p50 ${ms[4].toFixed(0).padStart(5)}  max ${ms[8].toFixed(0).padStart(5)} ms`);
      expect(ms[8]).toBeLessThan(5000);
    }
    console.log('\n' + rows.join('\n'));
  }, 300_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/tiles.test.ts; cd ..`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

`web/src/tiles/tileMath.ts`:
```ts
export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** [west, south, east, north] in degrees. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  return [tileLon(x, z), tileLat(y + 1, z), tileLon(x + 1, z), tileLat(y, z)];
}
```

`web/src/tiles/buildTile.ts`:
```ts
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { clipPolygon, clipPolyline } from 'lineclip';
import { decodeSubdivision, type RawObject } from '../img/rgn';
import { subdivisionBounds } from '../img/tre';
import { objectName, type GarminMap } from '../map/garminMap';
import { tileBounds } from './tileMath';

export const EXTENT = 4096;
export const BUFFER = 64;
const UNITS_PER_DEG = 16777216 / 360;
const LAYER = { point: 'points', line: 'lines', polygon: 'polygons' } as const;

type Pt = [number, number];
type BBox = [number, number, number, number];
interface TileFeature {
  type: 1 | 2 | 3;
  geometry: Pt[] | Pt[][];
  tags: Record<string, string | number>;
}

export class SubdivisionCache {
  private readonly map = new Map<string, RawObject[]>();
  constructor(private readonly max: number) {}

  get(key: string): RawObject[] | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: RawObject[]): void {
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function coordsBounds(coords: Array<[number, number]>): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function roundDedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of points) {
    const p: Pt = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

export async function buildTile(
  map: GarminMap, cache: SubdivisionCache, z: number, x: number, y: number,
): Promise<{ data: Uint8Array; badSections: number; features: number }> {
  const layers: Record<'points' | 'lines' | 'polygons', TileFeature[]> = { points: [], lines: [], polygons: [] };
  let badSections = 0;
  const bits = map.levelForZoom(z);
  if (bits !== undefined) {
    const [w, s, e, n] = tileBounds(z, x, y);
    const padX = ((e - w) * BUFFER) / EXTENT;
    const padY = ((n - s) * BUFFER) / EXTENT;
    const query: BBox = [(w - padX) * UNITS_PER_DEG, (s - padY) * UNITS_PER_DEG, (e + padX) * UNITS_PER_DEG, (n + padY) * UNITS_PER_DEG];
    const scale = 2 ** z;
    const project = ([mx, my]: [number, number]): Pt => {
      const lat = ((my / UNITS_PER_DEG) * Math.PI) / 180;
      return [
        ((mx / UNITS_PER_DEG + 180) / 360 * scale - x) * EXTENT,
        ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale - y) * EXTENT,
      ];
    };
    const clip: BBox = [-BUFFER, -BUFFER, EXTENT + BUFFER, EXTENT + BUFFER];

    for (const tile of map.tiles) {
      for (const sd of tile.byLevel.get(bits) ?? []) {
        if (!intersects(subdivisionBounds(sd), query)) continue;
        const key = `${tile.id}:${sd.index}`;
        let objs = cache.get(key);
        if (!objs) {
          const stats = { sections: 0, badSections: 0 };
          objs = decodeSubdivision(await map.readSubdivision(tile, sd), sd, stats);
          badSections += stats.badSections;
          cache.set(key, objs);
        }
        for (const obj of objs) {
          if (!intersects(coordsBounds(obj.coords), query)) continue;
          const pts = obj.coords.map(project);
          let feature: TileFeature | null = null;
          if (obj.kind === 'point') {
            const [px, py] = pts[0];
            if (px >= clip[0] && px <= clip[2] && py >= clip[1] && py <= clip[3]) feature = { type: 1, geometry: [[Math.round(px), Math.round(py)]], tags: {} };
          } else if (obj.kind === 'line') {
            const parts = clipPolyline(pts, clip).map(roundDedupe).filter((p) => p.length >= 2);
            if (parts.length) feature = { type: 2, geometry: parts, tags: {} };
          } else {
            const ring = roundDedupe(clipPolygon(pts, clip));
            if (ring.length >= 3) {
              const [f, l] = [ring[0], ring[ring.length - 1]];
              if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
              feature = { type: 3, geometry: [ring], tags: {} };
            }
          }
          if (!feature) continue;
          feature.tags.t = obj.type;
          const name = objectName(tile, obj);
          if (name) feature.tags.name = name;
          layers[LAYER[obj.kind]].push(feature);
        }
      }
    }
  }
  const data = fromGeojsonVt(
    { points: { features: layers.points }, lines: { features: layers.lines }, polygons: { features: layers.polygons } } as never,
    { version: 2, extent: EXTENT },
  );
  return { data, badSections, features: layers.points.length + layers.lines.length + layers.polygons.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/tiles.test.ts && npx tsc --noEmit; cd ..`
Expected: 4 passed. The timing table is printed; copy it into the report. If `@maplibre/vt-pbf`'s types reject the layer object even with the `as never` cast, add `web/src/types/vt-pbf.d.ts` declaring `fromGeojsonVt(layers: Record<string, { features: unknown[] }>, options?: { version?: number; extent?: number }): Uint8Array` and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add web/src/tiles web/test/tiles.test.ts
git commit -m "Build vector tiles on the fly from decoded subdivisions"
```

---

### Task 9: TYP parser (TypeScript port)

**Files:**
- Create: `web/src/img/typ.ts`, `web/test/typ.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`.
- Produces:
  - `interface RgbaImage { width: number; height: number; data: Uint8Array }`;
  - `PolygonStyle { color: string; pattern: RgbaImage | null }`;
  - `LineStyle { color: string; width: number; borderColor: string | null; borderWidth: number; dash: number[] | null }`;
  - `PointStyle { image: RgbaImage }`;
  - `Typ { polygons: Map; lines: Map; points: Map; drawLevel: Map<number, number> }`;
  - `parseTyp(data: Uint8Array): Typ` and `emptyTyp(): Typ`.

  Type keys use the RGN encoding.

- [ ] **Step 1: Write the failing tests** (the same fixtures as the Python `tests/test_typ.py`)

`web/test/typ.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { parseTyp } from '../src/img/typ';
import { bytesOf, concat } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

type El = [number, number[]];

function makeTyp(points: El[] = [], lines: El[] = [], polygons: El[] = [], order: Array<[number, number]> = []): Uint8Array {
  const hdr = new Uint8Array(0x5b);
  const dv = new DataView(hdr.buffer);
  dv.setUint16(0, 0x5b, true);
  hdr.set(bytesOf('GARMIN TYP'), 2);
  dv.setUint16(0x15, 1252, true);
  const body: number[] = [];
  const sections: Array<[number, number, Array<[number, number]>]> = [];
  for (const elements of [points, lines, polygons]) {
    const dataStart = body.length;
    const index: Array<[number, number]> = [];
    for (const [t16, data] of elements) {
      index.push([t16, body.length - dataStart]);
      body.push(...data);
    }
    sections.push([0x5b + dataStart, body.length - dataStart, index]);
  }
  const arrays: Array<[number, number, number]> = [];
  for (const [, , index] of sections) {
    const start = body.length;
    for (const [t16, off] of index) body.push(t16 & 0xff, t16 >> 8, off & 0xff, off >> 8);
    arrays.push([0x5b + start, 4, 4 * index.length]);
  }
  const orderStart = body.length;
  for (const [typ, mask] of order) body.push(typ, mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff, (mask >>> 24) & 0xff);
  arrays.push([0x5b + orderStart, 5, 5 * order.length]);
  sections.forEach(([off, len], i) => {
    dv.setUint32(0x17 + 8 * i, off, true);
    dv.setUint32(0x1b + 8 * i, len, true);
  });
  arrays.forEach(([off, mod, size], i) => {
    dv.setUint32(0x33 + 10 * i, off, true);
    dv.setUint16(0x37 + 10 * i, mod, true);
    dv.setUint32(0x39 + 10 * i, size, true);
  });
  return concat(hdr, new Uint8Array(body));
}

const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('parseTyp', () => {
  test('polygon solid colour and draw order', () => {
    const typ = parseTyp(makeTyp([], [], [[0x50 << 5, [0x06, 0x30, 0x20, 0x10]]], [[0x50, 0], [0, 0], [0x3c, 0]]));
    expect(typ.polygons.get(0x50)).toEqual({ color: '#102030', pattern: null });
    expect([...typ.drawLevel]).toEqual([[0x50, 1], [0x3c, 2]]);
  });

  test('polygon pattern', () => {
    const typ = parseTyp(makeTyp([], [], [[0x4e << 5, [0x08, 0, 0, 255, 255, 255, 255, ...new Array(128).fill(0xff)]]]));
    const s = typ.polygons.get(0x4e)!;
    expect(s.color).toBe('#ff0000');
    expect([s.pattern!.width, s.pattern!.height]).toEqual([32, 32]);
    expect(px(s.pattern!, 5, 5)).toEqual([255, 0, 0, 255]);
  });

  test('line with border', () => {
    const line = parseTyp(makeTyp([], [[0x16 << 5, [0x00, 0x00, 0, 0, 255, 0, 0, 0, 3, 5]]])).lines.get(0x16);
    expect(line).toEqual({ color: '#ff0000', width: 3, borderColor: '#000000', borderWidth: 5, dash: null });
  });

  test('bitmap line becomes dash', () => {
    const line = parseTyp(makeTyp([], [[0x0a << 5, [(1 << 3) | 0x06, 0x00, 0, 0, 255, 0xff, 0x00, 0xff, 0x00]]])).lines.get(0x0a)!;
    expect([line.color, line.width, line.dash]).toEqual(['#ff0000', 1, [8, 8, 8, 8]]);
  });

  test('point bitmap with subtype', () => {
    const img = parseTyp(makeTyp([[(0x2f << 5) | 6, [0x01, 4, 1, 1, 0x00, 0x00, 0xff, 0x00, 0b1010]]])).points.get(0x2f06)!.image;
    expect([img.width, img.height]).toEqual([4, 1]);
    expect(px(img, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(px(img, 1, 0)[3]).toBe(0);
  });
});

describe.skipIf(!hasRealData)('parseTyp on real data', () => {
  test('Detailed TYP', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const typ = parseTyp(await img.read(img.firstOfType('TYP')!));
    expect([typ.polygons.size, typ.lines.size, typ.points.size]).toEqual([36, 29, 14]);
    expect(typ.drawLevel.size).toBeGreaterThan(0);
    await src.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/typ.test.ts; cd ..`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement**

`web/src/img/typ.ts`:
```ts
/** TYP style file parser (port of imgconv/typ.py, itself ported from QMapShack's CGarminTyp). */
import { ascii, ImgError, u16, u32, u8 } from './bytes';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface PolygonStyle {
  color: string;
  pattern: RgbaImage | null;
}
export interface LineStyle {
  color: string;
  width: number;
  borderColor: string | null;
  borderWidth: number;
  dash: number[] | null;
}
export interface PointStyle {
  image: RgbaImage;
}
export interface Typ {
  polygons: Map<number, PolygonStyle>;
  lines: Map<number, LineStyle>;
  points: Map<number, PointStyle>;
  drawLevel: Map<number, number>;
}

export const emptyTyp = (): Typ => ({ polygons: new Map(), lines: new Map(), points: new Map(), drawLevel: new Map() });

type Rgba = [number, number, number, number];

class Reader {
  constructor(readonly d: Uint8Array, public pos = 0) {}
  u8(): number {
    return u8(this.d, this.pos++);
  }
  u16(): number {
    const v = u16(this.d, this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = u32(this.d, this.pos);
    this.pos += 4;
    return v;
  }
  rgb(): Rgba {
    const b = this.u8();
    const g = this.u8();
    const r = this.u8();
    return [r, g, b, 255];
  }
}

const hex = (c: Rgba) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');

function indices(r: Reader, w: number, h: number, bpp: number): number[][] {
  const perByte = Math.floor(8 / bpp);
  const mask = (1 << bpp) - 1;
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    while (row.length < w) {
      const byte = r.u8();
      for (let i = 0; i < perByte && row.length < w; i++) row.push((byte >> (i * bpp)) & mask);
    }
    rows.push(row);
  }
  return rows;
}

function image(rows: number[][], palette: Array<Rgba | null>): RgbaImage {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => row.forEach((idx, x) => {
    const c = idx < palette.length ? palette[idx] : null;
    if (c) data.set(c, (y * width + x) * 4);
  }));
  return { width, height, data };
}

function dash(rows: number[][]): number[] | null {
  const n = rows[0].length;
  const cols = Array.from({ length: n }, (_, x) => rows.some((row) => row[x] === 1));
  if (cols.every(Boolean) || !cols.some(Boolean)) return null;
  const start = cols.findIndex((on, i) => on && !cols[(i - 1 + n) % n]);
  const seq = [...cols.slice(start), ...cols.slice(0, start)];
  const runs: Array<[boolean, number]> = [];
  for (const on of seq) {
    const last = runs[runs.length - 1];
    if (last && last[0] === on) last[1] += 1;
    else runs.push([on, 1]);
  }
  return runs.map(([, len]) => len / rows.length);
}

function* elements(data: Uint8Array, array: [number, number, number], dataOffset: number): Generator<[number, Reader]> {
  const [off, mod, size] = array;
  if (!mod || !size || size % mod) return;
  const r = new Reader(data);
  for (let i = 0; i < size / mod; i++) {
    r.pos = off + i * mod;
    const t16 = r.u16();
    let o: number;
    if (mod === 5) o = r.u16() | (r.u8() << 16);
    else if (mod === 4) o = r.u16();
    else if (mod === 3) o = r.u8();
    else return;
    yield [t16, new Reader(data, dataOffset + o)];
  }
}

function linePolygonType(t16: number): number {
  const typ = ((t16 >> 5) | ((t16 & 0x1f) << 11)) & 0x7f;
  return t16 & 0x2000 ? 0x10000 | (typ << 8) | (t16 & 0x1f) : typ;
}

function pointType(t16: number): number {
  const typ = ((t16 >> 5) | ((t16 & 0x1f) << 11)) & 0x7ff;
  return t16 & 0x2000 ? 0x10000 | (typ << 8) | (t16 & 0x1f) : (typ << 8) + (t16 & 0x1f);
}

function polygon(r: Reader): PolygonStyle | null {
  const ctyp = r.u8() & 0x0f;
  if (ctyp === 0x01 || ctyp === 0x06 || ctyp === 0x07) return { color: hex(r.rgb()), pattern: null };
  if (ctyp === 0x08 || ctyp === 0x09 || ctyp === 0x0d) {
    const fg = r.rgb();
    const bg = r.rgb();
    if (ctyp === 0x09) {
      r.rgb();
      r.rgb();
    } else if (ctyp === 0x0d) {
      r.rgb();
    }
    return { color: hex(fg), pattern: image(indices(r, 32, 32, 1), [bg, fg]) };
  }
  if (ctyp === 0x0b || ctyp === 0x0e || ctyp === 0x0f) {
    const fg = r.rgb();
    if (ctyp === 0x0b) {
      r.rgb();
      r.rgb();
    } else if (ctyp === 0x0f) {
      r.rgb();
    }
    return { color: hex(fg), pattern: image(indices(r, 32, 32, 1), [null, fg]) };
  }
  return null;
}

const LINE_COLOURS: Record<number, number> = { 0x00: 2, 0x01: 4, 0x03: 3, 0x05: 3, 0x06: 1, 0x07: 2 };

function line(r: Reader): LineStyle | null {
  const f1 = r.u8();
  r.u8();
  const ctyp = f1 & 0x07;
  const rows = f1 >> 3;
  const ncolours = LINE_COLOURS[ctyp];
  if (ncolours === undefined) return null;
  const colours = Array.from({ length: ncolours }, () => r.rgb());
  const day = hex(colours[0]);
  if (rows) return { color: day, width: rows, borderColor: null, borderWidth: 0, dash: dash(indices(r, 32, rows, 1)) };
  let w1: number;
  let w2 = 0;
  if (ctyp === 0x00 || ctyp === 0x01 || ctyp === 0x03) {
    w1 = r.u8();
    w2 = r.u8();
  } else {
    w1 = r.u8();
  }
  if ((ctyp === 0x00 || ctyp === 0x01) && w2 > w1) return { color: day, width: w1, borderColor: hex(colours[1]), borderWidth: w2, dash: null };
  return { color: day, width: w1, borderColor: null, borderWidth: 0, dash: null };
}

function bpp(ncolors: number, flags: number): number | null {
  let table: Array<[number, number]>;
  if (flags === 0x00) table = [[3, ncolors], [4, 2], [16, 4], [256, 8]];
  else if (flags === 0x10) {
    if (ncolors === 0) return 1;
    table = [[3, 2], [15, 4], [256, 8]];
  } else if (flags === 0x20) {
    if (ncolors === 0) return 16;
    table = [[3, ncolors], [4, 2], [16, 4], [256, 8]];
  } else return null;
  for (const [limit, b] of table) if (ncolors < limit) return b;
  return null;
}

function colourTable(r: Reader, n: number, alpha: boolean): Rgba[] {
  if (!alpha) return Array.from({ length: n }, () => r.rgb());
  const out: Rgba[] = [];
  let reg = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    while (bits < 28) {
      reg += r.u8() * 2 ** bits;
      bits += 8;
    }
    const nibble = Math.floor(reg / 2 ** 24) % 16;
    out.push([Math.floor(reg / 65536) % 256, Math.floor(reg / 256) % 256, reg % 256, Math.round(((15 - nibble) * 255) / 15)]);
    reg = Math.floor(reg / 2 ** 28);
    bits -= 28;
  }
  return out;
}

function point(r: Reader): PointStyle | null {
  r.u8();
  const w = r.u8();
  const h = r.u8();
  const ncolors = r.u8();
  const flags = r.u8();
  const b = bpp(ncolors, flags);
  if (!b || b >= 16 || !w || !h) return null;
  const palette = colourTable(r, ncolors, flags === 0x20);
  return { image: image(indices(r, w, h, b), palette) };
}

function drawLevels(data: Uint8Array, array: [number, number, number]): Map<number, number> {
  const [off, mod, size] = array;
  const levels = new Map<number, number>();
  if (mod !== 5 || !size || size % 5) return levels;
  let level = 1;
  for (let i = 0; i < size / 5; i++) {
    const typ = u8(data, off + i * 5);
    const mask = u32(data, off + i * 5 + 1);
    if (typ === 0) level += 1;
    else if (mask === 0) levels.set(typ, level);
    else for (let n = 0; n < 32; n++) if (Math.floor(mask / 2 ** n) % 2 === 1) levels.set(0x10000 | (typ << 8) | n, level);
  }
  return levels;
}

export function parseTyp(data: Uint8Array): Typ {
  if (ascii(data, 2, 12) !== 'GARMIN TYP') throw new ImgError('TYP: bad signature');
  const r = new Reader(data, 0x17);
  const pointsData = [r.u32(), r.u32()];
  const linesData = [r.u32(), r.u32()];
  const polygonsData = [r.u32(), r.u32()];
  r.u16();
  r.u16();
  const arrays = Array.from({ length: 4 }, () => [r.u32(), r.u16(), r.u32()] as [number, number, number]);
  const typ: Typ = { ...emptyTyp(), drawLevel: drawLevels(data, arrays[3]) };
  for (const [t16, er] of elements(data, arrays[0], pointsData[0])) {
    const s = point(er);
    if (s) typ.points.set(pointType(t16), s);
  }
  for (const [t16, er] of elements(data, arrays[1], linesData[0])) {
    const s = line(er);
    if (s) typ.lines.set(linePolygonType(t16), s);
  }
  for (const [t16, er] of elements(data, arrays[2], polygonsData[0])) {
    const s = polygon(er);
    if (s) typ.polygons.set(linePolygonType(t16), s);
  }
  return typ;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/typ.test.ts && npx tsc --noEmit; cd ..`
Expected: 6 passed. The real TYP must give exactly 36 polygons, 29 lines and 14 points, the same as the Python parser.

- [ ] **Step 5: Commit**

```bash
git add web/src/img/typ.ts web/test/typ.test.ts
git commit -m "Port TYP style parser"
```

---

### Task 10: MapLibre style from the TYP

**Files:**
- Create: `web/src/style/fallback.ts`, `web/src/style/buildStyle.ts`, `web/test/style.test.ts`

**Interfaces:**
- Consumes: `Typ`, `RgbaImage`, `CONTOUR_LINE_TYPES`, `MIN_ZOOM` and `MAX_ZOOM`.
- Produces: `buildStyle(typ: Typ, opts: { tiles: string; glyphs: string }): { style: StyleSpecification; images: Map<string, RgbaImage> }`.
- Differences from `imgconv/stylegen.py`:
  - The type lists come from the TYP keys plus the fallback-table keys, because on-the-fly decoding has no `types.json`.
  - A catch-all `ln-other` line layer covers any other line type.
  - There is no hillshade layer and no `dem` source in Plan 1.
  - Images are returned for `map.addImage` rather than packed into a sprite.

- [ ] **Step 1: Write the failing tests**

`web/test/style.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { emptyTyp, type Typ } from '../src/img/typ';
import { buildStyle } from '../src/style/buildStyle';

const OPTS = { tiles: 'garmin://{z}/{x}/{y}', glyphs: 'http://x/fonts/{fontstack}/{range}.pbf' };
const img = (w: number, h: number) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });

describe('buildStyle', () => {
  test('layer order, sources, glyphs', () => {
    const typ: Typ = {
      ...emptyTyp(),
      polygons: new Map([[0x3c, { color: '#0000ff', pattern: null }], [0x50, { color: '#00ff00', pattern: null }]]),
      lines: new Map([[0x16, { color: '#ff0000', width: 3, borderColor: '#000000', borderWidth: 5, dash: null }]]),
      drawLevel: new Map([[0x50, 1], [0x3c, 2]]),
    };
    const { style } = buildStyle(typ, OPTS);
    const ids = style.layers.map((l) => l.id);
    expect(ids[0]).toBe('background');
    expect(ids.indexOf('pg-80')).toBeLessThan(ids.indexOf('pg-60'));
    expect(ids.indexOf('ln-22-casing')).toBeLessThan(ids.indexOf('ln-32'));
    expect(ids.indexOf('ln-32')).toBeLessThan(ids.indexOf('ln-22'));
    expect(ids).toContain('ln-other');
    expect(ids).not.toContain('hillshade');
    expect(style.sources.garmin).toEqual({ type: 'vector', tiles: [OPTS.tiles], minzoom: 4, maxzoom: 14 });
    expect(style.glyphs).toBe(OPTS.glyphs);
    const pg = style.layers.find((l) => l.id === 'pg-60') as { filter: unknown; paint: Record<string, unknown> };
    expect(pg.filter).toEqual(['==', ['get', 't'], 0x3c]);
    expect(pg.paint['fill-color']).toBe('#0000ff');
  });

  test('patterns and icons become images', () => {
    const typ: Typ = { ...emptyTyp(), polygons: new Map([[0x4e, { color: '#010203', pattern: img(32, 32) }]]), points: new Map([[0x2f06, { image: img(8, 8) }]]) };
    const { style, images } = buildStyle(typ, OPTS);
    expect([...images.keys()].sort()).toEqual(['pg-78', 'pt-12038']);
    const pg = style.layers.find((l) => l.id === 'pg-78') as { paint: Record<string, unknown> };
    expect(pg.paint['fill-pattern']).toBe('pg-78');
    const icons = style.layers.find((l) => l.id === 'poi-icons') as { filter: unknown };
    expect(icons.filter).toEqual(['in', ['get', 't'], ['literal', [0x2f06]]]);
  });

  test('fallbacks: skip 0x4a/0x4b, keep known defaults', () => {
    const ids = buildStyle(emptyTyp(), OPTS).style.layers.map((l) => l.id);
    expect(ids).not.toContain('pg-74');
    expect(ids).not.toContain('pg-75');
    expect(ids).toContain('pg-80');
    expect(ids).toContain('ln-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/style.test.ts; cd ..`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement**

`web/src/style/fallback.ts`, a direct port of `imgconv/fallback_styles.py`:
```ts
export const BACKGROUND = '#f4f0e4';

const WATER = '#a8d0ee';
const PARK = '#cde6b5';
export const POLYGON_COLORS = new Map<number, string>([
  [0x01, '#e3d7c5'], [0x02, '#e3d7c5'], [0x03, '#e3d7c5'], [0x04, '#d9d0c9'], [0x05, '#dddddd'], [0x06, '#dddddd'],
  [0x07, '#e0dcd8'], [0x08, '#e8d9c5'], [0x09, '#cfe0f0'], [0x0a, '#e8e0d0'], [0x0b, '#f0d8d8'], [0x0c, '#ddd5e8'],
  [0x0d, '#d8e8c8'], [0x0e, '#e0e0e0'], [0x13, '#d6c4ac'], [0x14, PARK], [0x15, PARK], [0x16, PARK],
  [0x17, '#d4ebbf'], [0x18, '#d4ebbf'], [0x19, '#dcebc9'], [0x1a, '#d0dcc8'], [0x1e, PARK], [0x1f, PARK], [0x20, PARK],
  [0x28, WATER], [0x29, WATER], [0x32, WATER], [0x3b, WATER], [0x3c, WATER], [0x3d, WATER], [0x3e, WATER],
  [0x3f, WATER], [0x40, WATER], [0x41, WATER], [0x42, WATER], [0x43, WATER], [0x44, WATER], [0x45, WATER],
  [0x46, WATER], [0x47, WATER], [0x48, WATER], [0x49, WATER], [0x4c, '#c4def0'], [0x4d, '#fbfdff'],
  [0x4e, '#dcebc0'], [0x4f, '#e0e8c8'], [0x50, '#b8dba0'], [0x51, '#c9e0d8'], [0x52, '#e6ecd6'], [0x53, '#f1e6c6'],
]);
/** 0x4A is the map coverage definition and 0x4B the background; drawn only if the TYP styles them. */
export const SKIP_POLYGONS = new Set([0x4a, 0x4b]);

type LineDef = [string, number, number[] | null];
const TRACK: LineDef = ['#a0703c', 1, [1, 1]];
export const LINE_STYLES = new Map<number, LineDef>([
  [0x01, ['#d4413a', 4, null]], [0x02, ['#e0662f', 3.5, null]], [0x03, ['#f0a040', 3, null]],
  [0x04, ['#f5c060', 2.5, null]], [0x05, ['#ffffff', 2, null]], [0x06, ['#ffffff', 1.5, null]],
  [0x07, ['#ffffff', 1, null]], [0x08, ['#f0a040', 2, null]], [0x09, ['#f0a040', 2, null]],
  [0x0a, ['#a0703c', 1.5, [2, 1]]], [0x0b, ['#f0a040', 2, null]], [0x0c, ['#ffffff', 1.5, null]],
  [0x0d, TRACK], [0x0e, TRACK], [0x0f, TRACK], [0x10, TRACK], [0x11, TRACK], [0x12, TRACK], [0x13, TRACK],
  [0x14, ['#555555', 1.5, [3, 2]]], [0x15, ['#4a86c5', 1, null]], [0x16, ['#c0392b', 1, [2, 1.5]]],
  [0x18, ['#4a86c5', 1, null]], [0x19, ['#999999', 1, [4, 2]]], [0x1a, ['#3c78d8', 1, [3, 2]]],
  [0x1b, ['#3c78d8', 1, [3, 2]]], [0x1c, ['#8e44ad', 1, [4, 2]]], [0x1d, ['#8e44ad', 1, [3, 2]]],
  [0x1e, ['#8e44ad', 1.5, [5, 2]]], [0x1f, ['#4a86c5', 2, null]], [0x20, ['#c8a07a', 0.5, null]],
  [0x21, ['#c8a07a', 0.7, null]], [0x22, ['#b08058', 1, null]], [0x23, ['#7fa7c9', 0.5, null]],
  [0x24, ['#7fa7c9', 0.7, null]], [0x25, ['#7fa7c9', 1, null]], [0x26, ['#4a86c5', 1, [2, 1]]],
  [0x27, ['#888888', 3, null]], [0x28, ['#777777', 1, [4, 2]]], [0x29, ['#888888', 1, null]],
  [0x2a, ['#4a86c5', 1, [4, 2]]], [0x2b, ['#d4413a', 1, [4, 2]]],
]);
export const DEFAULT_LINE: LineDef = ['#888888', 1, null];

const prio = (p: number, types: number[]) => types.map((t) => [t, p] as [number, number]);
/** Higher draws later (on top). */
export const LINE_PRIORITY = new Map<number, number>([
  ...prio(10, [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]),
  ...prio(20, [0x15, 0x18, 0x1f, 0x26]),
  ...prio(30, [0x19, 0x1c, 0x1d, 0x1e, 0x2a, 0x2b]),
  ...prio(35, [0x28, 0x29]),
  ...prio(40, [0x14, 0x1a, 0x1b]),
  ...prio(50, [0x0a, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x16]),
  ...prio(60, [0x05, 0x06, 0x07, 0x0c]),
  ...prio(70, [0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0b]),
]);
export const DEFAULT_LINE_PRIORITY = 45;
```

`web/src/style/buildStyle.ts`:
```ts
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { LineStyle, RgbaImage, Typ } from '../img/typ';
import { CONTOUR_LINE_TYPES, MAX_ZOOM, MIN_ZOOM } from '../map/zoom';
import { BACKGROUND, DEFAULT_LINE, DEFAULT_LINE_PRIORITY, LINE_PRIORITY, LINE_STYLES, POLYGON_COLORS, SKIP_POLYGONS } from './fallback';

const FONT_REGULAR = 'Noto Sans Regular';
const FONT_ITALIC = 'Noto Sans Italic';
const HALO = { 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 };
const CONTOURS = [...CONTOUR_LINE_TYPES].sort((a, b) => a - b);
const byType = (t: number) => ['==', ['get', 't'], t];

function lineLayer(id: string, t: number | null, color: string, width: number, dash: number[] | null, filter?: unknown): LayerSpecification {
  const paint: Record<string, unknown> = {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 8, Math.max(0.5, width * 0.4), 14, Math.max(1, width)],
  };
  if (dash) paint['line-dasharray'] = dash;
  return {
    id, type: 'line', source: 'garmin', 'source-layer': 'lines', filter: filter ?? byType(t!),
    layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' }, paint,
  } as LayerSpecification;
}

export function buildStyle(typ: Typ, opts: { tiles: string; glyphs: string }): { style: StyleSpecification; images: Map<string, RgbaImage> } {
  const images = new Map<string, RgbaImage>();
  const layers: LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } }];

  const polygonTypes = [...new Set([...typ.polygons.keys(), ...POLYGON_COLORS.keys()])]
    .sort((a, b) => (typ.drawLevel.get(a) ?? 0) - (typ.drawLevel.get(b) ?? 0) || a - b);
  for (const t of polygonTypes) {
    const s = typ.polygons.get(t);
    const base = { id: `pg-${t}`, type: 'fill' as const, source: 'garmin', 'source-layer': 'polygons', filter: byType(t) };
    if (s?.pattern) {
      images.set(`pg-${t}`, s.pattern);
      layers.push({ ...base, paint: { 'fill-pattern': `pg-${t}`, 'fill-antialias': false } } as LayerSpecification);
      continue;
    }
    const color = s ? s.color : SKIP_POLYGONS.has(t) ? undefined : POLYGON_COLORS.get(t);
    if (color) layers.push({ ...base, paint: { 'fill-color': color, 'fill-antialias': false } } as LayerSpecification);
  }

  const lineTypes = [...new Set([...typ.lines.keys(), ...LINE_STYLES.keys()])]
    .sort((a, b) => (LINE_PRIORITY.get(a) ?? DEFAULT_LINE_PRIORITY) - (LINE_PRIORITY.get(b) ?? DEFAULT_LINE_PRIORITY) || a - b);
  const lineStyle = (t: number): LineStyle => {
    const s = typ.lines.get(t);
    if (s) return s;
    const [color, width, dash] = LINE_STYLES.get(t) ?? DEFAULT_LINE;
    return { color, width, borderColor: null, borderWidth: 0, dash };
  };
  const [dc, dw] = DEFAULT_LINE;
  layers.push(lineLayer('ln-other', null, dc, dw, null, ['!', ['in', ['get', 't'], ['literal', lineTypes]]]));
  for (const t of lineTypes) {
    const s = lineStyle(t);
    if (s.borderColor) layers.push(lineLayer(`ln-${t}-casing`, t, s.borderColor, s.borderWidth, null));
  }
  for (const t of lineTypes) {
    const s = lineStyle(t);
    layers.push(lineLayer(`ln-${t}`, t, s.color, s.width, s.dash));
  }

  const isContour = ['in', ['get', 't'], ['literal', CONTOURS]];
  layers.push(
    { id: 'pg-labels', type: 'symbol', source: 'garmin', 'source-layer': 'polygons', filter: ['has', 'name'],
      layout: { 'text-field': ['get', 'name'], 'text-font': [FONT_ITALIC], 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': '#2c5a85', ...HALO } },
    { id: 'contour-labels', type: 'symbol', source: 'garmin', 'source-layer': 'lines', filter: ['all', ['has', 'name'], isContour],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [FONT_REGULAR], 'text-size': 9 },
      paint: { 'text-color': '#8a6a4a', ...HALO } },
    { id: 'line-labels', type: 'symbol', source: 'garmin', 'source-layer': 'lines', filter: ['all', ['has', 'name'], ['!', isContour]],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [FONT_REGULAR], 'text-size': 11, 'text-max-angle': 30 },
      paint: { 'text-color': '#333333', ...HALO } },
  ] as LayerSpecification[]);

  const iconTypes = [...typ.points.keys()].sort((a, b) => a - b);
  for (const t of iconTypes) images.set(`pt-${t}`, typ.points.get(t)!.image);
  const hasIcon = ['in', ['get', 't'], ['literal', iconTypes]];
  const text = { 'text-font': [FONT_REGULAR], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 8 };
  layers.push(
    { id: 'poi-dots', type: 'circle', source: 'garmin', 'source-layer': 'points', filter: ['!', hasIcon],
      paint: { 'circle-radius': 2.5, 'circle-color': '#555555', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } },
    { id: 'poi-dot-labels', type: 'symbol', source: 'garmin', 'source-layer': 'points', filter: ['all', ['!', hasIcon], ['has', 'name']],
      layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 0.8], ...text }, paint: { 'text-color': '#222222', ...HALO } },
    { id: 'poi-icons', type: 'symbol', source: 'garmin', 'source-layer': 'points', filter: hasIcon,
      layout: { 'icon-image': ['concat', 'pt-', ['to-string', ['get', 't']]], 'text-field': ['coalesce', ['get', 'name'], ''],
                'text-offset': [0, 1.1], 'text-optional': true, ...text },
      paint: { 'text-color': '#222222', ...HALO } },
  ] as LayerSpecification[]);

  const style: StyleSpecification = {
    version: 8,
    name: 'GPSmap.is (on the fly)',
    sources: { garmin: { type: 'vector', tiles: [opts.tiles], minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM } },
    glyphs: opts.glyphs,
    layers,
  };
  return { style, images };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/style.test.ts && npx tsc --noEmit; cd ..`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/style web/test/style.test.ts
git commit -m "Generate MapLibre style from the TYP in the browser"
```

---

### Task 11: Viewer, worker pool, screenshots and the SPIKE CHECKPOINT

**Files:**
- Create: `web/index.html`, `web/src/main.ts`, `web/src/worker/tileWorker.ts`, `web/src/worker/pool.ts`, `web/src/ui/perf.ts`, `web/scripts/screenshots.mjs`

**Interfaces:**
- Consumes: `GarminMap`, `BlobSource`, `buildTile`, `SubdivisionCache`, `parseTyp`, `emptyTyp` and `buildStyle`.
- Produces:
  - a page that opens an IMG file via `#file` and renders it with instrumentation;
  - `window.__app = { map, perf, ready }`;
  - `npm run screenshots`, which writes `out/web-samples/*.png` and prints the perf summary.

- [ ] **Step 1: Worker, pool and perf**

`web/src/worker/tileWorker.ts`:
```ts
/// <reference lib="webworker" />
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';
import { buildTile, SubdivisionCache } from '../tiles/buildTile';

declare const self: DedicatedWorkerGlobalScope;

let opened: Promise<GarminMap> | null = null;
const cache = new SubdivisionCache(1500);

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const m = await opened;
      self.postMessage({ type: 'opened', id: msg.id, bounds: m.bounds, typ: m.typ, tileIds: m.tiles.map((t) => t.id) });
    } else if (msg.type === 'tile') {
      if (!opened) throw new Error('map not opened');
      const m = await opened;
      const t0 = performance.now();
      const r = await buildTile(m, cache, msg.z, msg.x, msg.y);
      const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
      self.postMessage({ type: 'tile', id: msg.id, data: buf, ms: performance.now() - t0, badSections: r.badSections, features: r.features }, [buf]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
```

`web/src/worker/pool.ts`:
```ts
export interface OpenMeta {
  bounds: [number, number, number, number];
  typ: Uint8Array | null;
  tileIds: string[];
}

export interface TileResult {
  data: ArrayBuffer;
  ms: number;
  badSections: number;
  features: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class TilePool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private seq = 0;

  constructor(private readonly file: File, size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.onMessage(e.data);
      w.onerror = (e) => this.failAll(new Error(e.message || 'worker error'));
      this.workers.push(w);
    }
  }

  private call(w: Worker, msg: Record<string, unknown>): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id });
    });
  }

  private onMessage(msg: { id: number; type: string; message?: string }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async open(): Promise<OpenMeta> {
    const results = await Promise.all(this.workers.map((w) => this.call(w, { type: 'open', file: this.file })));
    const { bounds, typ, tileIds } = results[0];
    return { bounds, typ, tileIds };
  }

  /** Neighbouring tiles go to the same worker so its subdivision cache is reused. */
  tile(z: number, x: number, y: number): Promise<TileResult> {
    const w = this.workers[((x >> 1) + (y >> 1) * 7) % this.workers.length];
    return this.call(w, { type: 'tile', z, x, y });
  }
}
```

`web/src/ui/perf.ts`:
```ts
export class PerfStats {
  private readonly ms: number[] = [];
  private bad = 0;
  private features = 0;

  constructor(private readonly el: HTMLElement) {}

  record(ms: number, badSections: number, features: number): void {
    this.ms.push(ms);
    this.bad += badSections;
    this.features += features;
    this.el.textContent = this.summary();
  }

  summary(): string {
    if (!this.ms.length) return 'no tiles yet';
    const s = [...this.ms].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0);
    return `tiles ${s.length}  p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${s[s.length - 1].toFixed(0)} ms\n` +
      `features ${this.features}  bad sections ${this.bad}`;
  }
}
```

- [ ] **Step 2: Page and main**

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Garmin map viewer</title>
    <style>
      html, body { margin: 0; height: 100%; font: 14px -apple-system, system-ui, sans-serif; }
      #map { position: absolute; inset: 0; }
      #panel { position: absolute; top: 8px; left: 8px; z-index: 2; background: #fffe; padding: 8px; border-radius: 6px;
               box-shadow: 0 1px 4px #0003; max-width: calc(100% - 32px); }
      #perf { font: 12px ui-monospace, monospace; white-space: pre; margin-top: 6px; }
      #error { color: #b00020; white-space: pre-wrap; }
      #jumps button { margin: 4px 4px 0 0; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div id="panel">
      <input id="file" type="file" accept=".img" />
      <div id="jumps"></div>
      <div id="perf"></div>
      <div id="error"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/main.ts`:
```ts
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { emptyTyp, parseTyp } from './img/typ';
import { buildStyle } from './style/buildStyle';
import { PerfStats } from './ui/perf';
import { TilePool } from './worker/pool';

/** MapLibre zooms, i.e. one less than the raster samples' zoom, so the scale matches. */
const SAMPLES: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: 'reykjavik-z14', center: [-21.94, 64.146], zoom: 14 },
  { name: 'landmannalaugar-z12', center: [-19.06, 63.99], zoom: 12 },
  { name: 'vatnajokull-z10', center: [-16.9, 64.02], zoom: 10 },
  { name: 'iceland-z6', center: [-18.6, 64.9], zoom: 6 },
];

declare global {
  interface Window {
    __app?: { map: maplibregl.Map; perf: PerfStats; ready: boolean; samples: typeof SAMPLES };
  }
}

const $ = (id: string) => document.getElementById(id)!;

async function start(file: File): Promise<void> {
  const pool = new TilePool(file, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
  const meta = await pool.open();
  const perf = new PerfStats($('perf'));
  maplibregl.addProtocol('garmin', async (params) => {
    const m = /^garmin:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`bad tile url ${params.url}`);
    const r = await pool.tile(Number(m[1]), Number(m[2]), Number(m[3]));
    perf.record(r.ms, r.badSections, r.features);
    return { data: r.data };
  });
  const typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  const glyphs = new URL('fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  const { style, images } = buildStyle(typ, { tiles: 'garmin://{z}/{x}/{y}', glyphs });
  const [w, s, e, n] = meta.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[w, s], [e, n]], maxZoom: 18 });
  map.on('styleimagemissing', (ev) => {
    const img = images.get(ev.id);
    if (img && !map.hasImage(ev.id)) map.addImage(ev.id, img);
  });
  map.on('error', (ev) => console.error(ev.error));
  for (const sample of SAMPLES) {
    const b = document.createElement('button');
    b.textContent = sample.name;
    b.onclick = () => map.jumpTo({ center: sample.center, zoom: sample.zoom });
    $('jumps').append(b);
  }
  window.__app = { map, perf, ready: false, samples: SAMPLES };
  map.once('idle', () => (window.__app!.ready = true));
}

($('file') as HTMLInputElement).addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  $('error').textContent = '';
  try {
    await start(file);
  } catch (err) {
    $('error').textContent = err instanceof Error ? err.message : String(err);
  }
});
```

- [ ] **Step 3: Build and typecheck**

Run: `cd web && npx tsc --noEmit && npm run build && npx vitest run; cd ..`
Expected: tsc passes, `vite build` writes `web/dist/` (gitignored), and all tests pass.

- [ ] **Step 4: Screenshot script**

`web/scripts/screenshots.mjs`:
```js
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const IMG = REPO + 'GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
const OUT = REPO + 'out/web-samples/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(OUT, { recursive: true });
const server = await createServer({ root: WEB, server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024 });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5199/');
  const input = await page.$('#file');
  await input.uploadFile(IMG);
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180_000 });
  const samples = await page.evaluate(() => window.__app.samples);
  for (const s of samples) {
    await page.evaluate(
      (c, z) => new Promise((resolve) => {
        const map = window.__app.map;
        map.jumpTo({ center: c, zoom: z });
        map.once('idle', resolve);
      }),
      s.center, s.zoom,
    );
    await page.screenshot({ path: `${OUT}${s.name}.png` });
    console.log('wrote', `${OUT}${s.name}.png`);
  }
  console.log(await page.evaluate(() => window.__app.perf.summary()));
} finally {
  await browser.close();
  await server.close();
}
```

Run: `cd web && npm run screenshots; cd ..`
Expected: four PNGs under `out/web-samples/`, and a perf summary with 0 bad sections. Use the Read tool to look at each PNG next to the raster samples of the same places:
- `out/iceland-gpsmap-is-2024-21-detailed/samples/reykjavik-z15.png`
- `landmannalaugar-z13.png`
- `vatnajokull-z11.png`
- `iceland-z7.png`

The web samples have no hillshade (that comes in Plan 2). Otherwise, polygons, lines, labels and icons should match closely. If a PNG is blank, check the `[page]` console lines. The likely culprits are the glyph URL or a missing image.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/src/main.ts web/src/worker web/src/ui web/scripts/screenshots.mjs
git commit -m "Add on-the-fly viewer with worker pool, perf overlay and screenshot script"
```

- [ ] **Step 6: SPIKE CHECKPOINT — stop and report to the user**

Present the following to the user:
- the Node timing table from Task 8;
- the headless perf summary;
- the four web screenshots next to the raster samples.

Then ask the user to try it in Safari on the Mac: run `cd web && npm run dev`, open the printed URL, pick the IMG file, pan around and read the perf overlay.

Go/no-go against the spec's targets:
- z14 tiles around Reykjavík under 100 ms;
- opening the map in under 2 s;
- panning feels smooth.

If it's a go, write Plan 2 (hillshade, search, GPS, PWA and deployment). If it's a no-go, propose one of the spec's fallbacks. **Do not continue without the user's decision.**
