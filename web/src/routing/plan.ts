import { fastestRoute, type NodeIndex, type RoadGraph, type Route } from './graph';

export type RouteReply =
  | { status: 'ok'; coords: Array<[number, number]>; metres: number; seconds: number }
  | { status: 'no-road-start' | 'no-road-end' | 'no-route' };

/**
 * Snaps `from`/`to` onto the road network (within 2 km of a node) and searches for the fastest
 * route between them, reporting why not when either step fails. `shape` turns a found route into
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
  const a = index.nearest(from[0], from[1], 2000);
  if (!a) return { status: 'no-road-start' };
  const b = index.nearest(to[0], to[1], 2000);
  if (!b) return { status: 'no-road-end' };
  const route = fastestRoute(graph, a.node, b.node, allowFRoads);
  if (!route) return { status: 'no-route' };
  return { status: 'ok', coords: await shape(route), metres: route.metres, seconds: route.seconds };
}
