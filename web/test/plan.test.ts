import { describe, expect, test } from 'vitest';
import { EDGE_FROAD, GraphBuilder, NodeIndex, UNITS_PER_DEG, type RoadGraph } from '../src/routing/graph';
import { routeMessage } from '../src/app/routeMessage';
import { planRoute } from '../src/routing/plan';

const toUnits = (lon: number, lat: number): [number, number] => [Math.round(lon * UNITS_PER_DEG), Math.round(lat * UNITS_PER_DEG)];

/** a --(normal road, 1000 m, 50 km/h)-- b --(F-road only, 1000 m, 50 km/h)-- c, all on the
 *  equator so distances are easy to reason about; c is ~3.3 km from b, so only its F-road is within
 *  2 km of it. A point far from all three (10°, 10°) is well past the 2 km snap radius, for the
 *  'no-road-start'/'no-road-end' cases. */
function buildGraph(): { graph: RoadGraph; index: NodeIndex; a: [number, number]; b: [number, number]; c: [number, number]; far: [number, number] } {
  const gb = new GraphBuilder();
  const [ax, ay] = toUnits(0, 0);
  const [bx, by] = toUnits(0.01, 0);
  const [cx, cy] = toUnits(0.04, 0);
  const a = gb.node(ax, ay);
  const b = gb.node(bx, by);
  const c = gb.node(cx, cy);
  gb.edge(a, b, 1000, 50, 0);
  gb.edge(b, a, 1000, 50, 0);
  gb.edge(b, c, 1000, 50, EDGE_FROAD);
  gb.edge(c, b, 1000, 50, EDGE_FROAD);
  const graph = gb.build();
  return { graph, index: new NodeIndex(graph), a: [0, 0], b: [0.01, 0], c: [0.04, 0], far: [10, 10] };
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

  test('no-route: allowFRoads is false and the start has only an F-road within 2 km', async () => {
    const { graph, index, c, a } = buildGraph();
    await expect(planRoute(graph, index, c, a, false, noShape)).resolves.toEqual({ status: 'no-route' });
  });

  test('with F-roads not allowed, the ends snap past a nearer F-road-only node to a normal road', async () => {
    // a — b normal; b — d an F-road stub 300 m past b. Near d, the F-road node d is nearest.
    const gb = new GraphBuilder();
    const a = gb.node(...toUnits(0, 0));
    const b = gb.node(...toUnits(0.01, 0));
    const d = gb.node(...toUnits(0.0127, 0));
    gb.edge(a, b, 1000, 50, 0);
    gb.edge(b, a, 1000, 50, 0);
    gb.edge(b, d, 300, 50, EDGE_FROAD);
    gb.edge(d, b, 300, 50, EDGE_FROAD);
    const graph = gb.build();
    const index = new NodeIndex(graph);
    const nearD: [number, number] = [0.0128, 0];
    const without = await planRoute(graph, index, [0, 0], nearD, false, async (r) => r.nodes.map((n) => [n, 0]));
    expect(without).toMatchObject({ status: 'ok', coords: [[a, 0], [b, 0]] });
    const withF = await planRoute(graph, index, [0, 0], nearD, true, async (r) => r.nodes.map((n) => [n, 0]));
    expect(withF).toMatchObject({ status: 'ok', coords: [[a, 0], [b, 0], [d, 0]] });
  });

  test('no-route-any: F-roads allowed and still no way there (a one-way road the wrong way)', async () => {
    const gb = new GraphBuilder();
    const a = gb.node(...toUnits(0, 0));
    const b = gb.node(...toUnits(0.01, 0));
    gb.edge(a, b, 1000, 50, 0);
    const graph = gb.build();
    await expect(planRoute(graph, new NodeIndex(graph), [0.01, 0], [0, 0], true, noShape)).resolves.toEqual({ status: 'no-route-any' });
  });

  test('same-place: start and end snap to the same node', async () => {
    const { graph, index, a } = buildGraph();
    await expect(planRoute(graph, index, a, [0.0005, 0], true, noShape)).resolves.toEqual({ status: 'same-place' });
  });

  test('no-routing-data: a map without NOD subfiles gives an empty graph', async () => {
    const graph = new GraphBuilder().build();
    await expect(planRoute(graph, new NodeIndex(graph), [0, 0], [0.01, 0], true, noShape)).resolves.toEqual({ status: 'no-routing-data' });
  });
});

describe('routeMessage', () => {
  test('no road at the start: names your position or the map centre', () => {
    expect(routeMessage({ status: 'no-road-start' }, true)).toBe('No road near your position');
    expect(routeMessage({ status: 'no-road-start' }, false)).toBe('No road near the map centre');
  });

  test('each failure has its message', () => {
    expect(routeMessage({ status: 'no-road-end' }, true)).toBe('No road within 2 km of the destination');
    expect(routeMessage({ status: 'no-route' }, true)).toBe('No route without F-roads and tracks: turn the switch on to allow them');
    expect(routeMessage({ status: 'no-route-any' }, true)).toBe('No route by road between these places');
    expect(routeMessage({ status: 'no-routing-data' }, true)).toBe('This map has no routing data');
    expect(routeMessage({ status: 'same-place' }, true)).toBe("You're already there");
  });

  test('errors show their message, not "Error: …"', () => {
    expect(routeMessage({ status: 'error', err: new Error('Routing is unavailable') }, true)).toBe('Routing is unavailable');
    expect(routeMessage({ status: 'error', err: 'boom' }, true)).toBe('boom');
  });
});
