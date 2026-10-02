import type { LonLat } from '../routing/plan';
import { metres } from '../routing/maneuvers';
import type { JoinedRoute } from '../routing/waypoints';
import type { Gpx } from './parse';
import type { TrackRoute } from './store';

/** Walking pace for a straight leg off the road (m/s): 4 km/h. */
export const WALK_MPS = 4 / 3.6;

/**
 * A planned route as a track to keep: its line from the chosen start to the destination (the
 * straight legs off the road at either end included), the waypoints and destination as GPX
 * waypoints, and its road stretches, so navigating the track later gives the same turns.
 */
export function routeAsTrack(name: string, r: JoinedRoute, dest: { name: string | null; lon: number; lat: number }, vias: Array<{ name: string | null; lon: number; lat: number }>): { gpx: Gpx; route: TrackRoute } {
  const pts: LonLat[] = [...r.coords];
  let segs = (r.segs?.length ? r.segs : [{ start: 0, name: null, type: 0, junction: false, seconds: r.seconds }]).map((s) => ({ ...s }));
  let seconds = r.seconds;
  if (r.offRoadStart) {
    const walk = metres(r.offRoadStart[0], r.offRoadStart[1]) / WALK_MPS;
    pts.unshift(r.offRoadStart[0]);
    segs = [{ start: 0, name: null, type: 0, junction: false, seconds: walk, trail: true, offRoad: true }, ...segs.map((s, i) => ({ ...s, start: s.start + 1, ...(i === 0 ? { junction: true } : {}) }))];
    seconds += walk;
  }
  if (r.offRoadEnd) {
    const walk = metres(r.offRoadEnd[0], r.offRoadEnd[1]) / WALK_MPS;
    pts.push(r.offRoadEnd[1]);
    segs.push({ start: pts.length - 2, name: null, type: 0, junction: true, seconds: walk, trail: true, offRoad: true });
    seconds += walk;
  }
  const point = ([lon, lat]: LonLat) => ({ lon, lat, ele: null, time: null });
  return {
    gpx: {
      name,
      lines: [{ kind: 'route', name, points: pts.map(point) }],
      waypoints: [...vias, dest].map((p) => ({ name: p.name, lon: p.lon, lat: p.lat, ele: null })),
    },
    route: { segs, seconds },
  };
}
