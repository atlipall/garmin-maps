import { describe, expect, test } from 'vitest';
import { EDGE_FROAD, fastestRoute, GraphBuilder, hasNormalRoad, NodeIndex, UNITS_PER_DEG } from '../src/routing/graph';
import { addTileNetwork } from '../src/routing/network';
import type { NodNode } from '../src/routing/nod';
import { RoadClassCollector, roadClass } from '../src/routing/roadClass';

const U = (deg: number) => Math.round(deg * UNITS_PER_DEG);

describe('road classes', () => {
  test('F-roads by type or name, tracks, rough tracks, everything else normal', () => {
    expect(roadClass(0x12, null)).toBe(1);
    expect(roadClass(0x0d, 'F26')).toBe(1);
    expect(roadClass(0x0a, 'F 208')).toBe(1);
    expect(roadClass(0x11, null)).toBe(2);
    expect(roadClass(0x13, 'VATNAHJALLALEIÐ')).toBe(3);
    expect(roadClass(0x01, 'Hringvegur')).toBe(0);
    expect(roadClass(0x06, 'Fálkagata')).toBe(0); // starts with F but isn't a road number
  });

  test('the collector keeps one entry per NET offset per tile and leaves out normal roads', () => {
    const c = new RoadClassCollector();
    c.add('t1', 5, 1);
    c.add('t1', 5, 1); // the same road drawn as a second line
    c.add('t1', 6, 0);
    c.add('t1', 8, 2);
    c.add('t2', 5, 3); // NET offsets are per tile
    expect(c.roads).toEqual({ t1: [[5, 1], [8, 2]], t2: [[5, 3]] });
  });
});

describe('NOD network', () => {
  /** Nodes of one tile: a–b on a one-way highway (NET 1), b–c on an F-road (NET 2). */
  function tile(): Map<number, NodNode> {
    const n = (offset: number, lon: number, lat: number, arcs: NodNode['arcs']): NodNode => ({ offset, flags: 0x40, x: U(lon), y: U(lat), arcs, end: 0 });
    const arc = (target: number, length: number, forward: boolean, net: number, info: number) => ({ target, length, forward, direct: true, net, info, access: 0 });
    return new Map([
      [0, n(0, -21.0, 64.0, [arc(10, 1000, true, 1, 0x08 | 4)])],
      [10, n(10, -20.95, 64.0, [arc(0, 1000, false, 1, 0x08 | 4), arc(20, 500, true, 2, 2), { ...arc(30, 900, true, 2, 2), direct: false }])],
      [20, n(20, -20.95, 64.01, [arc(10, 500, false, 2, 2)])],
      [30, n(30, -20.95, 64.02, [])],
    ]);
  }
  const build = () => {
    const b = new GraphBuilder();
    addTileNetwork(b, tile(), new Map([[2, 1]]), 3);
    return b.build();
  };

  test('direct arcs become edges: length × 2.4 m, capped speed, F-road flag, road identity; one-way against is dropped', () => {
    const g = build();
    const idx = new NodeIndex(g);
    const a = idx.nearest(-21.0, 64.0, 100)!.node;
    const bN = idx.nearest(-20.95, 64.0, 100)!.node;
    const c = idx.nearest(-20.95, 64.01, 100)!.node;
    expect(fastestRoute(g, a, bN, true)!.metres).toBeCloseTo(2400, 3);
    expect(fastestRoute(g, bN, a, true)).toBeNull(); // one-way
    const f = fastestRoute(g, bN, c, true)!;
    expect(f.metres).toBeCloseTo(1200, 3);
    expect(f.seconds).toBeCloseTo(1200 / (25 / 3.6), 1); // class 2 (40 km/h) capped at 25
    expect(g.edgeFlags[f.edges[0]] & EDGE_FROAD).toBe(EDGE_FROAD);
    expect([g.edgeTile[f.edges[0]], g.edgeNet[f.edges[0]]]).toEqual([3, 2]);
    expect(fastestRoute(g, bN, c, false)).toBeNull(); // F-roads not allowed
    expect(g.edgeTo.length).toBe(3); // a→b, b→c, c→b (indirect b→d skipped, b→a one-way)
  });

  test('nearest(…, accept) skips nodes the predicate rejects; hasNormalRoad spots F-road-only nodes', () => {
    const g = build();
    const idx = new NodeIndex(g);
    const c = idx.nearest(-20.95, 64.01, 5000)!.node;
    expect(hasNormalRoad(g, c)).toBe(false); // only the F-road back to b
    const snapped = idx.nearest(-20.95, 64.01, 5000, (v) => hasNormalRoad(g, v))!;
    expect(snapped.node).toBe(idx.nearest(-21.0, 64.0, 100)!.node); // a: b's only normal edge is inbound
    expect(idx.nearest(-20.95, 64.01, 100, (v) => hasNormalRoad(g, v))).toBeNull();
  });

  test('edge tile indexes above 255 are kept', () => {
    const b = new GraphBuilder();
    b.edge(b.node(0, 0), b.node(10, 0), 10, 50, 0, null, { tile: 300, net: 7 });
    expect(b.build().edgeTile[0]).toBe(300);
  });
});
