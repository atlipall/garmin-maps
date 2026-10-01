import { fastestRoute, metresBetween, PREFER_FROAD_WEIGHT, UNITS_PER_DEG, type NodeIndex, type RoadGraph, type Route, type Terminal } from './graph';
import { cutLine, lineMetres, Snapper, type Anchor, type RoadLines, type Side } from './snap';

export type LonLat = [number, number];

/** A stretch of the route along one road, from `coords[start]` to the next stretch's start: what
 *  turn instructions are made from. `junction`: a road branches off where it starts; `via`: a
 *  waypoint's number, on the first stretch after it. */
export interface RoadSeg {
  start: number;
  name: string | null;
  type: number;
  junction: boolean;
  seconds: number;
  via?: number;
}

/** A graph route drawn along its roads, with its road stretches. */
export interface Shaped {
  coords: LonLat[];
  segs: RoadSeg[];
}

export type RouteReply =
  | {
      status: 'ok';
      coords: LonLat[];
      /** Road distance and time: from the snapped start point to the snapped destination. */
      metres: number;
      seconds: number;
      /** Straight legs between a chosen point and its road when that is more than 30 m away
       *  ([chosen start, road] and [road, destination]), with their lengths (0 when none). */
      offRoadStart: [LonLat, LonLat] | null;
      offRoadEnd: [LonLat, LonLat] | null;
      offRoadStartM: number;
      offRoadEndM: number;
      /** The roads along `coords` (none for a route along a single stretch, and in routes saved
       *  before turn instructions). */
      segs?: RoadSeg[];
    }
  | { status: 'no-road-start' | 'no-road-end' | 'no-route' | 'no-route-any' | 'no-routing-data' | 'same-place' };

/** A chosen point further than this from its road gets a drawn off-road leg. */
export const OFF_ROAD_M = 30;
/** Snapped ends closer than this are the same place. */
const SAME_PLACE_M = 5;

const deg = (p: [number, number]): LonLat => [p[0] / UNITS_PER_DEG, p[1] / UNITS_PER_DEG];
const seconds = (metres: number, kmh: number) => (kmh > 0 ? metres / (kmh / 3.6) : 0);

/**
 * Snaps `from`/`to` to the nearest point on a road (within 50 km; see ./snap.ts) and searches for
 * the fastest route between those points, reporting why not when either step fails. With F-roads not
 * allowed only normal roads count; an end with only an F-road or track within reach is reported as
 * 'no-route' (turning the switch on would help). `shape` turns a found graph route into on-road
 * coordinates (the worker passes `routeShape` bound to its subdivision cache) and `lines` finds road
 * lines, so this is testable against a synthetic graph and lines alone. `preferFRoads` (with F-roads
 * allowed) favours F-roads and tracks when choosing the route; the time reported stays the real one.
 */
export async function planRoute(
  graph: RoadGraph,
  index: NodeIndex,
  lines: RoadLines,
  from: LonLat,
  to: LonLat,
  allowFRoads: boolean,
  shape: (route: Route) => Promise<LonLat[] | Shaped>,
  preferFRoads = false,
): Promise<RouteReply> {
  if (graph.nodeX.length === 0) return { status: 'no-routing-data' };
  const snapper = new Snapper(graph, index, lines);
  const a = await snapper.snap(from, true, allowFRoads);
  if (!a) return { status: !allowFRoads && (await snapper.snap(from, true, true)) ? 'no-route' : 'no-road-start' };
  const b = await snapper.snap(to, false, allowFRoads);
  if (!b) return { status: !allowFRoads && (await snapper.snap(to, false, true)) ? 'no-route' : 'no-road-end' };
  const u = (p: LonLat) => [p[0] * UNITS_PER_DEG, p[1] * UNITS_PER_DEG] as const;
  if (metresBetween(...u(from), ...u(to)) < SAME_PLACE_M) return { status: 'same-place' };

  const offRoad = (chosen: LonLat, anchor: Anchor, atStart: boolean) => {
    if (anchor.offM <= OFF_ROAD_M) return { leg: null, metres: 0 };
    const road = deg(anchor.at);
    return { leg: (atStart ? [chosen, road] : [road, chosen]) as [LonLat, LonLat], metres: anchor.offM };
  };
  const start = offRoad(from, a, true);
  const end = offRoad(to, b, false);
  const ok = (coords: LonLat[], metres: number, secs: number, segs?: RoadSeg[]): RouteReply => ({
    status: 'ok',
    coords,
    metres,
    seconds: secs,
    offRoadStart: start.leg,
    offRoadEnd: end.leg,
    offRoadStartM: start.metres,
    offRoadEndM: end.metres,
    ...(segs ? { segs } : {}),
  });

  // Different places that join the road at the same point: only the off-road legs (the road part
  // is the two snapped points, no distance or time).
  // A route along one stretch has a single road stretch (its road's name isn't known here), so a
  // route joined from legs keeps every leg's stretches.
  const one = (secs: number): RoadSeg[] => [{ start: 0, name: null, type: 0, junction: false, seconds: secs }];
  if (metresBetween(a.at[0], a.at[1], b.at[0], b.at[1]) < SAME_PLACE_M) return ok([deg(a.at), deg(b.at)], 0, 0, one(0));

  const direct = alongOneStretch(a, b);
  if (direct) {
    const secs = seconds(direct.metres, direct.kmh);
    return ok(direct.path.map(deg), direct.metres, secs, one(secs));
  }

  const sources: Terminal[] = a.sides.filter((s) => s.leave > 0).map((s) => ({ node: s.node, cost: seconds(s.metres, s.leave) }));
  const targets: Terminal[] = b.sides.filter((s) => s.arrive > 0).map((s) => ({ node: s.node, cost: seconds(s.metres, s.arrive) }));
  const route = fastestRoute(graph, sources, targets, allowFRoads, allowFRoads && preferFRoads ? PREFER_FROAD_WEIGHT : 1);
  if (!route) return { status: allowFRoads ? 'no-route-any' : 'no-route' };
  const first = route.nodes[0];
  const last = route.nodes[route.nodes.length - 1];
  const sa = a.sides.find((s) => s.node === first && s.leave > 0) as Side;
  const sb = b.sides.find((s) => s.node === last && s.arrive > 0) as Side;
  const shaped = await shape(route);
  const middle = Array.isArray(shaped) ? shaped : shaped.coords;
  const coords = [...sa.path.map(deg), ...middle.slice(1), ...[...sb.path].reverse().slice(1).map(deg)];
  // The road stretches, moved past the partial stretch at the start; the partial stretches' times go
  // to the first and last.
  let segs: RoadSeg[] | undefined;
  if (!Array.isArray(shaped) && shaped.segs.length) {
    const offset = sa.path.length - 1;
    segs = shaped.segs.map((s, i) => ({ ...s, start: i === 0 ? 0 : s.start + offset }));
    segs[0].seconds += seconds(sa.metres, sa.leave);
    segs[segs.length - 1].seconds += seconds(sb.metres, sb.arrive);
  }
  return ok(coords, sa.metres + route.metres + sb.metres, route.seconds, segs);
}

/** The way straight along the road when both ends lie on the same stretch between two nodes and
 *  the road may be driven from one to the other; null otherwise. */
function alongOneStretch(a: Anchor, b: Anchor): { path: Array<[number, number]>; metres: number; kmh: number } | null {
  const sa = a.stretch;
  const sb = b.stretch;
  if (!sa || !sb || sa.tile !== sb.tile || sa.net !== sb.net) return null;
  let alongB: number;
  if (sa.u === sb.u && sa.v === sb.v) alongB = sb.along;
  else if (sa.u === sb.v && sa.v === sb.u) alongB = lineMetres(sb.line) - sb.along;
  else return null;
  const forward = alongB > sa.along;
  // Towards v is a's second side's `leave`, towards u its first's.
  const kmh = forward ? a.sides[1].leave : a.sides[0].leave;
  if (!kmh) return null;
  const path = forward ? cutLine(sa.line, sa.along, alongB) : cutLine(sa.line, alongB, sa.along).reverse();
  return { path, metres: Math.abs(alongB - sa.along), kmh };
}
