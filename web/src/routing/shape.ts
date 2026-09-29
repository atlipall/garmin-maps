import type { RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import type { GarminMap, MapTile } from '../map/garminMap';
import { paddedSubdivisionBounds } from '../tiles/buildTile';
import { UNITS_PER_DEG, type RoadGraph, type Route } from './graph';

const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

/** The part of `line` from the point `from` to the point `to` (both vertices of it), in that order. */
export function sliceBetween(line: Array<[number, number]>, from: [number, number], to: [number, number]): Array<[number, number]> | null {
  const i = line.findIndex((p) => same(p, from));
  const j = line.findIndex((p) => same(p, to));
  if (i < 0 || j < 0) return null;
  return i <= j ? line.slice(i, j + 1) : line.slice(j, i + 1).reverse();
}

/**
 * The route drawn along its roads: for each edge, the road line with the edge's NET offset that
 * contains both end nodes, cut between them. Subdivisions around the route's nodes are decoded via
 * `decode` (the worker's cache). An edge without a matching line is drawn straight.
 */
export async function routeShape(map: GarminMap, g: RoadGraph, route: Route, decode: (tile: MapTile, sd: Subdivision) => Promise<RawObject[]>): Promise<Array<[number, number]>> {
  const bits = Math.max(...map.bands.keys());
  const linesAt = new Map<string, RawObject[]>();
  const roadLines = async (tileIndex: number, x: number, y: number): Promise<RawObject[]> => {
    const tile = map.tiles[tileIndex];
    const out: RawObject[] = [];
    for (const sd of tile.byLevel.get(bits) ?? []) {
      const [w, s, e, n] = paddedSubdivisionBounds(sd);
      if (x < w || x > e || y < s || y > n) continue;
      const key = `${tile.id}:${sd.index}`;
      let objs = linesAt.get(key);
      if (!objs) {
        objs = (await decode(tile, sd)).filter((o) => o.kind === 'line' && o.labelSrc === 'net');
        linesAt.set(key, objs);
      }
      out.push(...objs);
    }
    return out;
  };
  const deg = (p: [number, number]): [number, number] => [p[0] / UNITS_PER_DEG, p[1] / UNITS_PER_DEG];
  const coords: Array<[number, number]> = [];
  let prev = route.nodes[0];
  coords.push(deg([g.nodeX[prev], g.nodeY[prev]]));
  for (const e of route.edges) {
    const v = g.edgeTo[e];
    const a: [number, number] = [g.nodeX[prev], g.nodeY[prev]];
    const b: [number, number] = [g.nodeX[v], g.nodeY[v]];
    let piece: Array<[number, number]> | null = null;
    if (g.edgeNet[e] >= 0) {
      for (const o of await roadLines(g.edgeTile[e], a[0], a[1])) {
        if (o.label !== g.edgeNet[e]) continue;
        piece = sliceBetween(o.coords, a, b);
        if (piece) break;
      }
    }
    for (const p of (piece ?? [a, b]).slice(1)) coords.push(deg(p));
    prev = v;
  }
  return coords;
}
