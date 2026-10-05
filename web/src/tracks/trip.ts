import type { Gpx, GpxPoint } from '../gpx/parse';

/**
 * A trip recorded by the Android app (android/.../Trip.java), handed to the map in the address after
 * `#` when recording stops: `trip=1.<start ms>.<end ms>.<points>.<seconds>`, the points and each
 * point's seconds after the previous one in the Google encoded-polyline form (%-escaped).
 */
export interface Trip {
  start: number;
  end: number;
  points: GpxPoint[];
}

/** The numbers of an encoded polyline, or null when it's cut short. */
export function decodeNumbers(s: string): number[] | null {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    let shift = 0;
    let v = 0;
    let c: number;
    do {
      if (i >= s.length) return null;
      c = s.charCodeAt(i++) - 63;
      if (c < 0 || c > 63) return null;
      v += (c & 0x1f) * 2 ** shift;
      shift += 5;
    } while (c >= 0x20);
    out.push(v % 2 ? -(v + 1) / 2 : v / 2);
  }
  return out;
}

/** The trip in an address fragment (with or without its `#`), or null when there is none. */
export function parseTrip(hash: string): Trip | null {
  const m = /^#?trip=1\.(\d+)\.(\d+)\.([^.]*)\.([^.]*)$/.exec(hash);
  if (!m) return null;
  let coords: number[] | null;
  let secs: number[] | null;
  try {
    coords = decodeNumbers(decodeURIComponent(m[3]));
    secs = decodeNumbers(decodeURIComponent(m[4]));
  } catch {
    return null;
  }
  if (!coords || !secs || coords.length % 2 || coords.length / 2 !== secs.length) return null;
  const start = Number(m[1]);
  const points: GpxPoint[] = [];
  let lat = 0;
  let lon = 0;
  let t = Math.floor(start / 1000);
  for (let k = 0; k < secs.length; k++) {
    lat += coords[2 * k];
    lon += coords[2 * k + 1];
    t += secs[k];
    points.push({ lat: lat / 1e5, lon: lon / 1e5, ele: null, time: t * 1000 });
  }
  return { start, end: Number(m[2]), points };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The suggested name: "Drive 5 Oct, 14:20–14:31" (local time). */
export function tripName(start: number, end: number): string {
  const a = new Date(start);
  return `Drive ${a.getDate()} ${MONTHS[a.getMonth()]}, ${hm(a)}–${hm(new Date(end))}`;
}

/** The trip as a track's GPX: one line, no waypoints. */
export function tripGpx(trip: Trip, name: string): Gpx {
  return { name, lines: [{ kind: 'track', name, points: trip.points }], waypoints: [] };
}

/** The id a trip is stored under: the same trip handed over twice (a reload) is kept once. */
export const tripId = (trip: Trip): string => `trip-${trip.start.toString(36)}`;
