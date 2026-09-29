import type { Gpx } from './parse';

/** Height changes smaller than this (m) are treated as GPS/barometer noise, not climbing. */
const CLIMB_THRESHOLD = 3;

export interface GpxStats {
  /** Metres along all tracks and routes. */
  distance: number;
  /** Metres climbed, or null when no point has a height. */
  climb: number | null;
  /** Milliseconds from the first to the last timestamp, or null with fewer than two. */
  duration: number | null;
}

function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total ascent over lines of heights (nulls skipped). A rise counts once it clears the noise
 *  threshold above the lowest height since the last counted rise. */
export function climb(lines: Array<Array<number | null>>): number | null {
  let total = 0;
  let any = false;
  for (const heights of lines) {
    let ref: number | null = null;
    for (const h of heights) {
      if (h === null) continue;
      any = true;
      if (ref === null || h < ref) ref = h;
      else if (h - ref >= CLIMB_THRESHOLD) {
        total += h - ref;
        ref = h;
      }
    }
  }
  return any ? Math.round(total) : null;
}

export function summarize(gpx: Gpx): GpxStats {
  let distance = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const l of gpx.lines) {
    for (let i = 0; i < l.points.length; i++) {
      const p = l.points[i];
      if (i) distance += metres(l.points[i - 1], p);
      if (p.time !== null) {
        first = Math.min(first, p.time);
        last = Math.max(last, p.time);
      }
    }
  }
  return {
    distance,
    climb: climb(gpx.lines.map((l) => l.points.map((p) => p.ele))),
    duration: last > first ? last - first : null,
  };
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return m < 10_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  if (h < 48) return h % 24 ? `1 day ${h % 24} h` : '1 day';
  return `${Math.round(h / 24)} days`;
}

/** "54 km · ↑ 1,850 m · 2 days": the parts that are known. */
export function formatStats(s: GpxStats): string {
  return [
    s.distance > 0 ? formatDistance(s.distance) : null,
    s.climb !== null ? `↑ ${s.climb.toLocaleString('en-US')} m` : null,
    s.duration !== null ? formatDuration(s.duration) : null,
  ].filter(Boolean).join(' · ');
}
