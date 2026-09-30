import type { LocationState } from '../location/modes';

/** A place a route goes to (a search result or a dropped pin). */
export interface Place {
  name: string | null;
  lon: number;
  lat: number;
}

/** The route card as it was: the place, and when routed, where from (a point, or null for your
 *  position). */
export interface SessionRoute {
  dest: Place;
  routed: boolean;
  from: [number, number] | null;
}

/** What the app brings back after iOS closes it (or it's reopened): the map view, location mode
 *  and route card. Tied to the map file it was saved with. */
export interface Session {
  map: string;
  view: { center: [number, number]; zoom: number; bearing: number };
  location: LocationState;
  route: SessionRoute | null;
}

const KEY = 'session';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLonLat = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isPlace = (v: unknown): v is Place => {
  const p = v as Place;
  return !!p && (p.name === null || typeof p.name === 'string') && isNum(p.lon) && isNum(p.lat);
};

/** The stored session for map file `map`, or null when there's none, it's for another map, or it
 *  doesn't look right (an older format, hand-edited storage). */
export function parseSession(raw: string | null, map: string): Session | null {
  if (!raw) return null;
  let s: Session;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!s || s.map !== map) return null;
  const v = s.view;
  if (!v || !isLonLat(v.center) || !isNum(v.zoom) || !isNum(v.bearing)) return null;
  const l = s.location;
  if (!l || !['off', 'north', 'heading'].includes(l.mode) || typeof l.paused !== 'boolean') return null;
  const r = s.route;
  if (r !== null && (!r || !isPlace(r.dest) || typeof r.routed !== 'boolean' || (r.from !== null && !isLonLat(r.from)))) return null;
  return { map, view: { center: v.center, zoom: v.zoom, bearing: v.bearing }, location: { mode: l.mode, paused: l.paused }, route: r && { dest: r.dest, routed: r.routed, from: r.from } };
}

export function loadSession(map: string): Session | null {
  try {
    return parseSession(localStorage.getItem(KEY), map);
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered (private mode, full storage); the app works as before
  }
}
