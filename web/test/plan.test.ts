import { describe, expect, test } from 'vitest';
import { EDGE_FROAD, GraphBuilder, NodeIndex, UNITS_PER_DEG, type RoadGraph } from '../src/routing/graph';
import { planRoute } from '../src/routing/plan';

const toUnits = (lon: number, lat: number): [number, number] => [Math.round(lon * UNITS_PER_DEG), Math.round(lat * UNITS_PER_DEG)];

/** a --(normal road, 1000 m, 50 km/h)-- b --(F-road only, 1000 m, 50 km/h)-- c, all on one line
 *  of longitude so distances are easy to reason about. A point far from all three (10°, 10°) is
 *  well past the 2 km snap radius, for the 'no-road-start'/'no-road-end' cases. */
function buildGraph(): { graph: RoadGraph; index: NodeIndex; a: [number, number]; b: [number, number]; c: [number, number]; far: [number, number] } {
  const gb = new GraphBuilder();
  const [ax, ay] = toUnits(0, 0);
  const [bx, by] = toUnits(0.01, 0);
  const [cx, cy] = toUnits(0.02, 0);
  const a = gb.node(ax, ay);
  const b = gb.node(bx, by);
  const c = gb.node(cx, cy);
  gb.edge(a, b, 1000, 50, 0);
  gb.edge(b, a, 1000, 50, 0);
  gb.edge(b, c, 1000, 50, EDGE_FROAD);
  gb.edge(c, b, 1000, 50, EDGE_FROAD);
  const graph = gb.build();
  return { graph, index: new NodeIndex(graph), a: [0, 0], b: [0.01, 0], c: [0.02, 0], far: [10, 10] };
}

const noShape = async (): Promise<Array<[number, number]>> => {
  throw new Error('shape should not have been called');
};

describe('planRoute', () => {
  test('ok: coords come from the shape callback, metres/seconds from the found route', async () => {
    const { graph, index, a, b } = buildGraph();
    const sentinel: Array<[number, number]> = [[1, 2], [3, 4]];
    const result = await planRoute(graph, index, a, b, true, async () => sentinel);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.coords).toBe(sentinel);
    expect(result.metres).toBeCloseTo(1000, 6);
    expect(result.seconds).toBeCloseTo(1000 / (50 / 3.6), 6);
  });

  test('no-road-start: the start point is more than 2 km from any road', async () => {
    const { graph, index, b, far } = buildGraph();
    await expect(planRoute(graph, index, far, b, true, noShape)).resolves.toEqual({ status: 'no-road-start' });
  });

  test('no-road-end: the end point is more than 2 km from any road', async () => {
    const { graph, index, a, far } = buildGraph();
    await expect(planRoute(graph, index, a, far, true, noShape)).resolves.toEqual({ status: 'no-road-end' });
  });

  test('no-route: the destination is reachable only over an F-road and allowFRoads is false', async () => {
    const { graph, index, a, c } = buildGraph();
    await expect(planRoute(graph, index, a, c, false, noShape)).resolves.toEqual({ status: 'no-route' });
  });
});
