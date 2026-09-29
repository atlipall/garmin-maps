import type { ImgContainer } from '../img/container';
import { F_TYPES, isFRoadName, type RoadLine } from './engineA';
import { EDGE_FROAD, GraphBuilder, type RoadGraph } from './graph';
import { parseNodHeader, readNodes } from './nod';

/** Garmin road speed classes (Table A bits 0-2) in km/h, as mkgmap documents them. */
export const SPEED_CLASS_KMH = [5, 20, 40, 60, 80, 90, 110, 128];
/** NOD arc lengths are in units of about 2.4 m (measured on the GPSmap.is data: straight direct
 *  arcs give 2.41 m per unit, lengths being rounded down). */
export const NOD_UNIT_M = 2.4;

/** Per tile: the NET offsets of F-roads and 4×4 tracks, from the road lines. */
export function fRoadNets(lines: RoadLine[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const l of lines) {
    if (l.net === null || !(F_TYPES.has(l.type) || isFRoadName(l.name))) continue;
    const set = out.get(l.tile) ?? out.set(l.tile, new Set()).get(l.tile)!;
    set.add(l.net);
  }
  return out;
}

/**
 * Engine B: the graph from Garmin's own routing network (NOD). Direct arcs become edges with
 * Garmin's length, speed class and one-way flag; tiles join at their shared boundary nodes.
 * Without `fRoads`, no edge is flagged as an F-road (the F-road switch then has no effect).
 */
export async function graphFromNod(img: ImgContainer, fRoads?: Map<string, Set<number>>): Promise<RoadGraph> {
  const b = new GraphBuilder();
  for (const id of img.tileIds()) {
    if (!img.has(`${id}.NOD`)) continue;
    const nod = await img.read(`${id}.NOD`);
    const hdr = parseNodHeader(nod);
    const nodes = readNodes(nod.subarray(hdr.nod1.offset, hdr.nod1.offset + hdr.nod1.length), nod.subarray(hdr.nod2.offset, hdr.nod2.offset + hdr.nod2.length), hdr);
    const f = fRoads?.get(id);
    for (const n of nodes.values()) {
      const u = b.node(n.x, n.y);
      for (const a of n.arcs) {
        if (!a.direct) continue;
        if (a.info & 0x08 && !a.forward) continue; // one-way, and this arc runs against it
        const t = nodes.get(a.target);
        if (!t) continue;
        b.edge(u, b.node(t.x, t.y), a.length * NOD_UNIT_M, SPEED_CLASS_KMH[a.info & 7], f?.has(a.net) ? EDGE_FROAD : 0);
      }
    }
  }
  return b.build();
}
