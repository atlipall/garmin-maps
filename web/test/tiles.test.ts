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
