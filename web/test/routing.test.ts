import { describe, expect, test } from 'vitest';
import { graphFromLines, type RoadLine } from '../src/routing/engineA';
import { fastestRoute, NodeIndex, UNITS_PER_DEG } from '../src/routing/graph';

const U = (deg: number) => Math.round(deg * UNITS_PER_DEG);
/** A line through [lon, lat] points. */
const line = (type: number, name: string | null, ...pts: Array<[number, number]>): RoadLine =>
  ({ type, name, coords: pts.flatMap(([lo, la]) => [U(lo), U(la)]), net: null, tile: 't' });

describe('engine A: graph from road lines', () => {
  // Two roads between the same two ends: a fast highway on a long detour (~48 km at 80 km/h, about
  // 36 min) and a slow but direct F-road (~6 km at 25 km/h, about 15 min).
  const lines = [
    line(0x01, 'Route 1', [0, 64], [0.5, 63.85], [0.1, 64.05]),
    line(0x12, 'F208', [0, 64], [0.05, 64.02], [0.1, 64.05]),
    line(0x06, 'Spur', [0.05, 64.02], [0.06, 64.02]), // meets the F-road mid-way: makes a junction
  ];
  const g = graphFromLines(lines);
  const idx = new NodeIndex(g);
  const at = (lon: number, lat: number) => idx.nearest(lon, lat, 2000)!.node;

  test('joins lines at shared points; only junctions and line ends are nodes', () => {
    // Nodes: the two shared ends, the F-road/spur junction, and the spur's far end. The highway's
    // corner is a single line's interior point, so it is shape, not a node.
    expect(g.nodeX.length).toBe(4);
    expect(g.edgeTo.length).toBe(2 * 4); // highway, F-road in two halves, spur; both ways
  });

  test('fastest route prefers the F-road when allowed and the highway when not', () => {
    const a = at(0, 64);
    const b = at(0.1, 64.05);
    const withF = fastestRoute(g, a, b, true)!;
    const noF = fastestRoute(g, a, b, false)!;
    expect(withF.nodes).toEqual([a, at(0.05, 64.02), b]); // along the F-road, via its junction
    expect(withF.coords).toHaveLength(3);
    expect(noF.nodes).toEqual([a, b]);
    expect(noF.coords).toHaveLength(3); // with the highway's corner
    expect(noF.metres).toBeGreaterThan(withF.metres);
    expect(noF.seconds).toBeGreaterThan(withF.seconds); // the F-road shortcut is faster when allowed
  });

  test('snapping: only to the main network, and only within the limit', () => {
    // An island road isn't joined to the main network, so positions on it don't snap to it (a
    // route there would always fail); nor does a position far from any road.
    const island = graphFromLines([...lines, line(0x06, 'Island', [1, 65], [1.01, 65])]);
    const i2 = new NodeIndex(island);
    expect(i2.nearest(1, 65, 2000)).toBeNull();
    expect(i2.nearest(0, 64, 2000)).not.toBeNull();
    expect(i2.nearest(0.5, 64.5, 2000)).toBeNull();
  });
});
