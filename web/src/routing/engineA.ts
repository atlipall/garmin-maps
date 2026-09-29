import type { RawObject } from '../img/rgn';
import { decodeAll } from '../map/decodeAll';
import { objectName, type GarminMap } from '../map/garminMap';
import { EDGE_FROAD, GraphBuilder, metresBetween, type RoadGraph } from './graph';

/** Road line types routed over, with their assumed speeds (km/h). Trails, paths and ferries are not. */
export const ROAD_SPEEDS: ReadonlyMap<number, number> = new Map([
  [0x01, 80], [0x02, 70], [0x03, 60], [0x04, 60], [0x05, 60], [0x06, 30], [0x07, 20], [0x08, 50], [0x09, 50],
  [0x0a, 50], [0x0b, 60], [0x0c, 20], [0x0d, 50], [0x11, 20], [0x12, 25], [0x13, 15],
]);
export const F_TYPES = new Set([0x11, 0x12, 0x13]);
const F_SPEED = 25;
export const isFRoadName = (name: string | null) => !!name && /^F\s?\d+/i.test(name);

export interface RoadLine {
  type: number;
  name: string | null;
  /** Flat [x, y, x, y, …] in map units. */
  coords: number[];
  /** The road's NET record offset (its routing identity in NOD), or null. */
  net: number | null;
  /** The map tile (NET offsets are per tile). */
  tile: string;
}

/**
 * Engine A: a graph from the road lines themselves. Lines sharing an exact point are joined there;
 * every point used by more than one line (or twice by one line), and every line end, becomes a
 * node, and the stretches between nodes become edges in both directions with their shape.
 */
export function graphFromLines(lines: RoadLine[]): RoadGraph {
  const key = (x: number, y: number) => (x + 0x800000) * 0x1000000 + (y + 0x800000);
  const uses = new Map<number, number>();
  for (const l of lines) {
    const c = l.coords;
    for (let i = 0; i < c.length; i += 2) {
      const k = key(c[i], c[i + 1]);
      const end = i === 0 || i === c.length - 2;
      uses.set(k, (uses.get(k) ?? 0) + (end ? 2 : 1));
    }
  }
  const b = new GraphBuilder();
  for (const l of lines) {
    const f = F_TYPES.has(l.type) || isFRoadName(l.name);
    const speed = isFRoadName(l.name) ? F_SPEED : ROAD_SPEEDS.get(l.type) ?? 30;
    const flags = f ? EDGE_FROAD : 0;
    const c = l.coords;
    let start = b.node(c[0], c[1]);
    let metres = 0;
    let shape: number[] = [];
    for (let i = 2; i < c.length; i += 2) {
      metres += metresBetween(c[i - 2], c[i - 1], c[i], c[i + 1]);
      const last = i === c.length - 2;
      if (last || (uses.get(key(c[i], c[i + 1])) ?? 0) >= 2) {
        const end = b.node(c[i], c[i + 1]);
        const back: number[] = [];
        for (let k = shape.length - 2; k >= 0; k -= 2) back.push(shape[k], shape[k + 1]);
        b.edge(start, end, metres, speed, flags, shape.length ? shape : null);
        b.edge(end, start, metres, speed, flags, back.length ? back : null);
        start = end;
        metres = 0;
        shape = [];
      } else {
        shape.push(c[i], c[i + 1]);
      }
    }
  }
  return b.build();
}

/** Collects the routable road lines of the map's most detailed level. */
export async function roadLines(map: GarminMap): Promise<RoadLine[]> {
  const bits = Math.max(...map.bands.keys());
  const out: RoadLine[] = [];
  await decodeAll(map, (tile, _sd, obj: RawObject) => {
    if (obj.kind !== 'line' || !ROAD_SPEEDS.has(obj.type) || obj.coords.length < 2) return;
    out.push({ type: obj.type, name: objectName(tile, obj), coords: obj.coords.flat(), net: obj.labelSrc === 'net' ? obj.label : null, tile: tile.id });
  }, { bits });
  return out;
}
