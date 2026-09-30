import type { RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import type { GarminMap, MapTile } from '../map/garminMap';
import { paddedSubdivisionBounds } from '../tiles/buildTile';
import { metresBetween, UNITS_PER_DEG, type RoadGraph, type Route } from './graph';
import type { RoadClass, RoadClasses } from './roadClass';
import type { RoadLine, RoadLines } from './snap';

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

/**
 * Road lines for snapping (see ./snap.ts): the routable lines (`labelSrc === 'net'`) of the
 * finest-level subdivisions whose padded bounds reach the box around a point, decoded via `decode`
 * (the worker's cache), each with its road class from `classes`. One source serves one route
 * request: it keeps the lines it made, so a line is the same object each time it's returned.
 */
export function roadLineSource(map: GarminMap, decode: (tile: MapTile, sd: Subdivision) => Promise<RawObject[]>, classes: RoadClasses): RoadLines {
  const bits = Math.max(...map.bands.keys());
  const made = new Map<string, RoadLine[]>();
  const classOf = map.tiles.map((t) => new Map<number, RoadClass>(classes[t.id] ?? []));
  const unitsPerM = 1 / metresBetween(0, 0, 0, 1);
  return async (x, y, radiusM) => {
    const ry = radiusM * unitsPerM;
    const rx = ry / Math.max(0.01, Math.cos((y / UNITS_PER_DEG) * (Math.PI / 180)));
    const out: RoadLine[] = [];
    const wanted: Array<Promise<RoadLine[]>> = [];
    for (const [i, tile] of map.tiles.entries()) {
      // Tile bounds are in degrees; a margin covers rounding.
      const t = tile.tre;
      const m = 0.01 * UNITS_PER_DEG;
      if (x + rx + m < t.west * UNITS_PER_DEG || x - rx - m > t.east * UNITS_PER_DEG || y + ry + m < t.south * UNITS_PER_DEG || y - ry - m > t.north * UNITS_PER_DEG) continue;
      for (const sd of tile.byLevel.get(bits) ?? []) {
        const [w, s, e, n] = paddedSubdivisionBounds(sd);
        if (x + rx < w || x - rx > e || y + ry < s || y - ry > n) continue;
        const key = `${tile.id}:${sd.index}`;
        const have = made.get(key);
        if (have) {
          out.push(...have);
          continue;
        }
        wanted.push(decode(tile, sd).then((objs) => {
          const lines = made.get(key) ?? objs
            .filter((o) => o.kind === 'line' && o.labelSrc === 'net')
            .map((o) => ({ tile: i, net: o.label, cls: classOf[i].get(o.label) ?? 0, coords: o.coords }));
          made.set(key, lines);
          return lines;
        }));
      }
    }
    for (const lines of await Promise.all(wanted)) out.push(...lines);
    return out;
  };
}
