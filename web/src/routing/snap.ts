import { canArrive, canLeave, EDGE_FROAD, metresBetween, UNITS_PER_DEG, type NodeIndex, type RoadGraph } from './graph';
import type { RoadClass } from './roadClass';

/** A routable road line (finest level, NET-labelled) in map units, with its road (tile index, NET
 *  offset) and class. */
export interface RoadLine {
  tile: number;
  net: number;
  cls: RoadClass;
  coords: Array<[number, number]>;
}

/** Road lines that may come within `radiusM` metres of (x, y) (map units): those of every
 *  subdivision whose bounds reach that box. Must return the same line objects for the same line
 *  within one route request (lines are told apart by identity when joining them). */
export type RoadLines = (x: number, y: number, radiusM: number) => Promise<RoadLine[]>;

/** One way off the snapped point to a graph node. `leave`/`arrive`: the speed (km/h) of travelling
 *  from the point to the node / from the node to the point, 0 when the road doesn't allow it. */
export interface Side {
  node: number;
  metres: number;
  /** Map units, from the snapped point to the node. */
  path: Array<[number, number]>;
  leave: number;
  arrive: number;
}

/** Where a route end joins the road network. */
export interface Anchor {
  /** The snapped point on the road (or the fallback node), map units. */
  at: [number, number];
  /** Metres from the chosen point to `at`. */
  offM: number;
  sides: Side[];
  /** The stretch between the two nodes of the road the point lies on (null for a fallback node):
   *  its shape from `u` to `v` and the point's distance along it. */
  stretch: { tile: number; net: number; u: number; v: number; line: Array<[number, number]>; along: number } | null;
}

/** How far out to look for a road, in steps (metres). */
export const SNAP_STEPS_M = [2000, 10_000, 50_000];
/** Most lines tried per step before falling back to the nearest node. */
const MAX_TRIES = 50;
/** Most line pieces followed in one direction when a road is drawn as several lines. */
const MAX_JOINS = 100;

const M_PER_UNIT = metresBetween(0, 0, 0, 1);

/** Nearest point of `line` to q, in a local flat projection (fine at these distances). */
function nearestOnLine(line: Array<[number, number]>, qx: number, qy: number, kx: number): { i: number; t: number; x: number; y: number; d2: number } {
  let best = { i: 0, t: 0, x: line[0][0], y: line[0][1], d2: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = (bx - ax) * kx;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? (((qx - ax) * kx) * dx + (qy - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const ex = (px - qx) * kx;
    const ey = py - qy;
    const d2 = ex * ex + ey * ey;
    if (d2 < best.d2) best = { i, t, x: px, y: py, d2 };
  }
  if (line.length === 1) best.d2 = ((line[0][0] - qx) * kx) ** 2 + (line[0][1] - qy) ** 2;
  return best;
}

const lengthOf = (path: Array<[number, number]>) => {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += metresBetween(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return m;
};

const sameXY = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

/** Speed (km/h) of the edge u→v on road (tile, net) that the route may use, or 0 when there's none. */
function edgeSpeed(g: RoadGraph, u: number, v: number, tile: number, net: number, allowFRoads: boolean): number {
  for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
    if (g.edgeTo[e] !== v || g.edgeTile[e] !== tile || g.edgeNet[e] !== net) continue;
    if (!allowFRoads && g.edgeFlags[e] & EDGE_FROAD) continue;
    return g.edgeSpeed[e];
  }
  return 0;
}

/**
 * Snaps route ends to the nearest point on a road line (not just the nearest junction), searching
 * outward in steps up to 50 km; with F-roads not allowed only normal roads count. From that point
 * the road is followed both ways to the nearest graph nodes (road-line vertices and NOD nodes share
 * exact coordinates), joining the next line of the same road where one ends short of a node.
 */
export class Snapper {
  constructor(
    private readonly g: RoadGraph,
    private readonly index: NodeIndex,
    private readonly lines: RoadLines,
  ) {}

  /** The anchor for a route start (`start`) or destination at [lon, lat], or null when there's no
   *  usable road within 50 km. */
  async snap(p: [number, number], start: boolean, allowFRoads: boolean): Promise<Anchor | null> {
    const qx = Math.round(p[0] * UNITS_PER_DEG);
    const qy = Math.round(p[1] * UNITS_PER_DEG);
    const kx = Math.cos((p[1] * Math.PI) / 180);
    for (const radius of SNAP_STEPS_M) {
      const found = (await this.lines(qx, qy, radius))
        .filter((l) => (allowFRoads || l.cls === 0) && l.coords.length > 0)
        .map((l) => ({ l, near: nearestOnLine(l.coords, qx, qy, kx) }))
        .map((c) => ({ ...c, m: Math.sqrt(c.near.d2) * M_PER_UNIT }))
        .filter((c) => c.m <= radius)
        .sort((a, b) => a.m - b.m);
      for (const c of found.slice(0, MAX_TRIES)) {
        const anchor = await this.onLine(c.l, c.near, allowFRoads);
        if (anchor && anchor.sides.some((s) => (start ? s.leave : s.arrive) > 0)) {
          anchor.offM = metresBetween(qx, qy, anchor.at[0], anchor.at[1]);
          return anchor;
        }
      }
      // No line leads to a usable node: the nearest node that can be left (start) or reached (end).
      const ok = (v: number) => (start ? canLeave(this.g, v, allowFRoads) : canArrive(this.g, v, allowFRoads));
      const n = this.index.nearest(p[0], p[1], radius, ok);
      if (n) {
        const at: [number, number] = [this.g.nodeX[n.node], this.g.nodeY[n.node]];
        return { at, offM: n.metres, sides: [{ node: n.node, metres: 0, path: [at], leave: 1, arrive: 1 }], stretch: null };
      }
    }
    return null;
  }

  /** The anchor at the point `near` of `line`, or null when the stretch it lies on can't be tied to
   *  a pair of main-network nodes joined by an edge of this road. */
  private async onLine(line: RoadLine, near: { i: number; t: number; x: number; y: number }, allowFRoads: boolean): Promise<Anchor | null> {
    const at: [number, number] = [near.x, near.y];
    const back = await this.walk(line, near.i, -1, at);
    const ahead = await this.walk(line, near.i + 1, 1, at);
    if (!back || !ahead || back.node === ahead.node) return null;
    const u = back.node;
    const v = ahead.node;
    if (!this.index.inMain(u) || !this.index.inMain(v)) return null;
    const uv = edgeSpeed(this.g, u, v, line.tile, line.net, allowFRoads);
    const vu = edgeSpeed(this.g, v, u, line.tile, line.net, allowFRoads);
    if (!uv && !vu) return null;
    const dU = lengthOf(back.path);
    const dV = lengthOf(ahead.path);
    return {
      at,
      offM: 0,
      // Towards u means travelling v→u, towards v travelling u→v.
      sides: [
        { node: u, metres: dU, path: back.path, leave: vu, arrive: uv },
        { node: v, metres: dV, path: ahead.path, leave: uv, arrive: vu },
      ],
      stretch: { tile: line.tile, net: line.net, u, v, line: [...back.path].reverse().concat(ahead.path.slice(1)), along: dU },
    };
  }

  /** Follows the road from `at` through vertex `i` of `line` in direction `dir` to the first graph
   *  node, continuing onto the next line of the same road when a line ends first. */
  private async walk(line: RoadLine, i: number, dir: 1 | -1, at: [number, number]): Promise<{ node: number; path: Array<[number, number]> } | null> {
    const path: Array<[number, number]> = [at];
    let cur = line;
    for (let joins = 0; joins <= MAX_JOINS; joins++) {
      const c = cur.coords;
      for (; i >= 0 && i < c.length; i += dir) {
        if (!sameXY(path[path.length - 1], c[i])) path.push(c[i]);
        const node = this.index.nodeAt(c[i][0], c[i][1]);
        if (node >= 0) return { node, path };
      }
      // The line ends short of a node: the road goes on in another line starting or ending here.
      const end = path[path.length - 1];
      const next = (await this.lines(end[0], end[1], 0)).find((l) => l !== cur && l.tile === cur.tile && l.net === cur.net && (sameXY(l.coords[0], end) || sameXY(l.coords[l.coords.length - 1], end)));
      if (!next) return null;
      cur = next;
      const forward = sameXY(next.coords[0], end);
      dir = forward ? 1 : -1;
      i = forward ? 1 : next.coords.length - 2;
    }
    return null;
  }
}

/** The part of `line` between distances `a` < `b` along it (metres), both ends interpolated. */
export function cutLine(line: Array<[number, number]>, a: number, b: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = 0;
  const at = (i: number, d: number, len: number): [number, number] => {
    const t = len ? (d - s) / len : 0;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const len = metresBetween(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (!out.length && a <= s + len) out.push(at(i, a, len));
    if (out.length && b <= s + len) {
      out.push(at(i, b, len));
      return out;
    }
    if (out.length && !sameXY(out[out.length - 1], line[i + 1])) out.push(line[i + 1]);
    s += len;
  }
  if (!out.length) out.push(line[line.length - 1]);
  if (out.length === 1) out.push(line[line.length - 1]);
  return out;
}

export { lengthOf as lineMetres };
