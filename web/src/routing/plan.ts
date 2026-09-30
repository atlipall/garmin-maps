import { fastestRoute, hasNormalRoad, type NodeIndex, type RoadGraph, type Route } from './graph';

export type RouteReply =
  | { status: 'ok'; coords: Array<[number, number]>; metres: number; seconds: number }
  | { status: 'no-road-start' | 'no-road-end' | 'no-route' | 'no-route-any' | 'no-routing-data' | 'same-place' };

const SNAP_METRES = 2000;

/**
 * Snaps `from`/`to` onto the road network (within 2 km of a node) and searches for the fastest
 * route between them, reporting why not when either step fails. With F-roads not allowed, both
 * ends snap only to nodes with a normal road; an end that has only an F-road or track nearby is
 * reported as 'no-route' (turning the switch on would help). `shape` turns a found route into
 * on-road coordinates — the worker passes `routeShape` bound to its subdivision cache — so this
 * stays free of any decoding and is testable against a synthetic graph alone.
 */
export async function planRoute(
  graph: RoadGraph,
  index: NodeIndex,
  from: [number, number],
  to: [number, number],
  allowFRoads: boolean,
  shape: (route: Route) => Promise<Array<[number, number]>>,
): Promise<RouteReply> {
  if (graph.nodeX.length === 0) return { status: 'no-routing-data' };
  const accept = allowFRoads ? undefined : (v: number) => hasNormalRoad(graph, v);
  const snap = (p: [number, number]) => index.nearest(p[0], p[1], SNAP_METRES, accept);
  const anyRoad = (p: [number, number]) => index.nearest(p[0], p[1], SNAP_METRES) !== null;
  const a = snap(from);
  if (!a) return { status: accept && anyRoad(from) ? 'no-route' : 'no-road-start' };
  const b = snap(to);
  if (!b) return { status: accept && anyRoad(to) ? 'no-route' : 'no-road-end' };
  if (a.node === b.node) return { status: 'same-place' };
  const route = fastestRoute(graph, a.node, b.node, allowFRoads);
  if (!route) return { status: allowFRoads ? 'no-route-any' : 'no-route' };
  return { status: 'ok', coords: await shape(route), metres: route.metres, seconds: route.seconds };
}
