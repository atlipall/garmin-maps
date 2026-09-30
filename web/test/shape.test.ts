import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeSubdivision, type RawObject } from '../src/img/rgn';
import type { Subdivision } from '../src/img/tre';
import { GarminMap, type MapTile } from '../src/map/garminMap';
import { fastestRoute, metresBetween, NodeIndex, UNITS_PER_DEG } from '../src/routing/graph';
import { buildNetwork } from '../src/routing/network';
import { routeShape, sliceBetween } from '../src/routing/shape';
import { collectIndex } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, F_ROAD_DETAILED, hasRealData } from './helpers/paths';

describe('sliceBetween', () => {
  const line: Array<[number, number]> = [[0, 0], [1, 0], [2, 1], [3, 1], [4, 0]];
  test('the part of a line between two of its points, in travel order', () => {
    expect(sliceBetween(line, [1, 0], [3, 1])).toEqual([[1, 0], [2, 1], [3, 1]]);
    expect(sliceBetween(line, [4, 0], [2, 1])).toEqual([[4, 0], [3, 1], [2, 1]]);
  });
  test('null when either point is not on the line', () => {
    expect(sliceBetween(line, [1, 0], [9, 9])).toBeNull();
  });
});

describe.skipIf(!hasRealData)('routeShape on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
  }, 300_000);
  afterAll(() => src.close());

  test('the Reykjavík → Selfoss route is drawn along road-line vertices', async () => {
    const { roads } = await collectIndex(map);
    const g = await buildNetwork(map, roads);
    const idx = new NodeIndex(g);
    const from = idx.nearest(-21.94, 64.146, 2000)!.node;
    const to = idx.nearest(-21.0, 63.936, 2000)!.node;
    const route = fastestRoute(g, from, to, true)!;
    expect(route).not.toBeNull();

    // Collect every road-line vertex of every subdivision the decode function is asked for, so we
    // can check the shape stays on the decoded road lines (per the task's real-data test contract).
    const vertices = new Set<string>();
    const decode = async (tile: MapTile, sd: Subdivision): Promise<RawObject[]> => {
      const bytes = await map.readSubdivision(tile, sd);
      const objs = decodeSubdivision(bytes, sd, { sections: 0, badSections: 0 });
      for (const o of objs) {
        if (o.kind === 'line' && o.labelSrc === 'net') for (const [x, y] of o.coords) vertices.add(`${x},${y}`);
      }
      return objs;
    };

    const shape = await routeShape(map, g, route, decode);
    expect(shape.length).toBeGreaterThan(route.nodes.length);

    const toUnits = ([lon, lat]: [number, number]): [number, number] => [Math.round(lon * UNITS_PER_DEG), Math.round(lat * UNITS_PER_DEG)];
    const startNode = route.nodes[0];
    const endNode = route.nodes[route.nodes.length - 1];
    const [sx, sy] = toUnits(shape[0]);
    const [ex, ey] = toUnits(shape[shape.length - 1]);
    expect(metresBetween(sx, sy, g.nodeX[startNode], g.nodeY[startNode])).toBeLessThan(1);
    expect(metresBetween(ex, ey, g.nodeX[endNode], g.nodeY[endNode])).toBeLessThan(1);

    let onRoad = 0;
    for (const p of shape) {
      const [x, y] = toUnits(p);
      if (vertices.has(`${x},${y}`)) onRoad++;
    }
    const pct = (100 * onRoad) / shape.length;
    console.log(`shape points on a decoded road-line vertex: ${onRoad}/${shape.length} (${pct.toFixed(1)}%)`);
    expect(pct).toBeGreaterThanOrEqual(95);
  }, 300_000);
});

describe.skipIf(!hasRealData)('fastestRoute on real data (F-Road Detailed)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  let g: Awaited<ReturnType<typeof buildNetwork>>;
  let idx: NodeIndex;
  beforeAll(async () => {
    src = await nodeSource(F_ROAD_DETAILED);
    map = await GarminMap.open(src);
    const { roads } = await collectIndex(map);
    g = await buildNetwork(map, roads);
    idx = new NodeIndex(g);
  }, 300_000);
  afterAll(() => src.close());

  test('Reykjavík → Akureyri: found, 380-395 km', () => {
    const from = idx.nearest(-21.94, 64.146, 2000)!.node;
    const to = idx.nearest(-18.09, 65.68, 2000)!.node;
    const route = fastestRoute(g, from, to, true);
    expect(route).not.toBeNull();
    const km = route!.metres / 1000;
    console.log(`Reykjavík → Akureyri: ${km.toFixed(1)} km, ${(route!.seconds / 60).toFixed(0)} min`);
    expect(km).toBeGreaterThanOrEqual(380);
    expect(km).toBeLessThanOrEqual(395);
  });

  test('Selfoss → Landmannalaugar: found with F-roads in 2.2-3.3 h; null without', () => {
    const from = idx.nearest(-21.0, 63.936, 2000)!.node;
    const to = idx.nearest(-19.06, 63.991, 2000)!.node;
    const withFRoads = fastestRoute(g, from, to, true);
    expect(withFRoads).not.toBeNull();
    const hours = withFRoads!.seconds / 3600;
    console.log(`Selfoss → Landmannalaugar: ${(withFRoads!.metres / 1000).toFixed(1)} km, ${hours.toFixed(2)} h (F-roads allowed)`);
    expect(hours).toBeGreaterThanOrEqual(2.2);
    expect(hours).toBeLessThanOrEqual(3.3);

    const withoutFRoads = fastestRoute(g, from, to, false);
    expect(withoutFRoads).toBeNull();
  });

  test('Húsavík → Dettifoss: found', () => {
    const from = idx.nearest(-17.34, 66.045, 2000)!.node;
    const to = idx.nearest(-16.39, 65.81, 2000)!.node;
    const route = fastestRoute(g, from, to, true);
    expect(route).not.toBeNull();
    console.log(`Húsavík → Dettifoss: ${(route!.metres / 1000).toFixed(1)} km, ${(route!.seconds / 60).toFixed(0)} min`);
  });
});
