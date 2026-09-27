import { openAsBlob } from 'node:fs';
import { describe, test } from 'vitest';
import { BlobSource } from '../src/img/source';
import { GarminMap } from '../src/map/garminMap';
import { buildTile, SubdivisionCache } from '../src/tiles/buildTile';
import { latToTileY, lonToTileX } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

// Same tile sets as the timing test in tiles.test.ts, duplicated deliberately so this benchmark
// doesn't depend on that file's internals.
const around = (lon: number, lat: number, z: number) => {
  const [cx, cy] = [lonToTileX(lon, z), latToTileY(lat, z)];
  return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [z, cx + dx, cy + dy] as const));
};
const CASES: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
  'Reykjavík z14': around(-21.94, 64.146, 14),
  'Reykjavík z12': around(-21.94, 64.146, 12),
  'Landmannalaugar z13': around(-19.06, 63.99, 13),
  'Vatnajökull z10': around(-16.9, 64.02, 10),
  'Iceland z6': around(-18.6, 64.9, 6),
};

/** Builds every tile in every case against `map`, with a fresh SubdivisionCache per case, and
 *  returns one formatted "cold/p50/max" row per case. */
async function timeCases(map: GarminMap): Promise<string[]> {
  const rows: string[] = [];
  for (const [label, tiles] of Object.entries(CASES)) {
    // Default budget: this benchmark measures warm-cache reuse across the 3x3 neighbourhood, which
    // a tiny point budget would defeat by evicting subdivisions before the next tile reuses them.
    const cache = new SubdivisionCache();
    const ms: number[] = [];
    for (const [z, x, y] of tiles) {
      const t0 = performance.now();
      await buildTile(map, cache, z, x, y);
      ms.push(performance.now() - t0);
    }
    const cold = ms[0];
    const sorted = [...ms].sort((a, b) => a - b);
    const p50 = sorted[4];
    const max = sorted[8];
    rows.push(`${label.padEnd(22)} cold ${cold.toFixed(0).padStart(5)}  p50 ${p50.toFixed(0).padStart(5)}  max ${max.toFixed(0).padStart(5)} ms`);
  }
  return rows;
}

describe.skipIf(!hasRealData)('buildTile perf: BlobSource (browser-like, via fs.openAsBlob) vs nodeSource', () => {
  test('benchmark', async () => {
    const nSrc = await nodeSource(DETAILED);
    try {
      const nodeMap = await GarminMap.open(nSrc);
      const nodeRows = await timeCases(nodeMap);
      console.log('\n== nodeSource (fs reads) ==\n' + nodeRows.join('\n'));
    } finally {
      await nSrc.close();
    }

    // fs.openAsBlob (Node 24+) returns a file-backed lazy Blob whose slice().arrayBuffer() goes
    // through the same async read path a browser's File/Blob would, unlike a Blob built from
    // bytes already in memory.
    const blob = await openAsBlob(DETAILED);
    const bSrc = new BlobSource(blob);
    const blobMap = await GarminMap.open(bSrc);
    const blobRows = await timeCases(blobMap);
    console.log('\n== BlobSource (fs.openAsBlob, browser-like) ==\n' + blobRows.join('\n'));
  }, 300_000);
});
