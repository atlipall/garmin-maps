import type { RouteReply } from '../routing/plan';

const MESSAGES: Record<Exclude<RouteReply['status'], 'ok' | 'no-road-start'>, string> = {
  'no-road-end': 'No road within 2 km of the destination',
  'no-route': 'No route without F-roads and tracks: turn the switch on to allow them',
  'no-route-any': 'No route by road between these places',
  'no-routing-data': 'This map has no routing data',
  'same-place': "You're already there",
};

/** The panel's message for a failed route; `gps` says whether the start was your position. */
export function routeMessage(reply: Exclude<RouteReply, { status: 'ok' }> | { status: 'error'; err: unknown }, gps: boolean): string {
  if (reply.status === 'error') return reply.err instanceof Error ? reply.err.message : String(reply.err);
  if (reply.status === 'no-road-start') return gps ? 'No road near your position' : 'No road near the map centre';
  return MESSAGES[reply.status];
}
