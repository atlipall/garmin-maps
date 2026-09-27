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
