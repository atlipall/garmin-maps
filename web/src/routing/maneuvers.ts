import { titleCase } from '../search/describe';
import type { LonLat, RoadSeg } from './plan';

/** Garmin's line type for roundabouts. */
export const ROUNDABOUT = 0x0c;

export type Turn = 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right' | 'sharp-left' | 'sharp-right' | 'uturn';

/** One instruction along a route, at `coords[index]`, `along` metres from the start. */
export interface Maneuver {
  index: number;
  along: number;
  kind: 'depart' | 'turn' | 'keep' | 'continue' | 'roundabout' | 'via' | 'arrive';
  turn?: Turn;
  /** The roundabout exit to take (1 = first). */
  exit?: number;
  /** The waypoint's number, for a 'via'. */
  via?: number;
  /** The road taken, as shown ("road 26", "F26", "Sigtún"), or null when it has no name. */
  road: string | null;
  text: string;
}

/** How a map road name is said: numbers as "road 26", F-roads as they are, names in capitals in
 *  normal case. */
export function roadLabel(name: string | null): string | null {
  if (!name) return null;
  const n = name.trim();
  if (/^\d+$/.test(n)) return `road ${n}`;
  if (/^F\s?\d+$/i.test(n)) return n.replace(/\s/, '').toUpperCase();
  return titleCase(n);
}

const R = 6_371_000;
const rad = Math.PI / 180;

/** Metres between two [lon, lat] points (equirectangular; fine at these distances). */
export function metres(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * rad);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * rad * R;
}

/** Metres along the line to each of its points. */
export function cumulative(coords: LonLat[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + metres(coords[i - 1], coords[i]));
  return out;
}

/** Compass bearing (degrees clockwise from north) from a to b. */
function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * rad);
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) / rad + 360) % 360;
}

/** The point `dist` metres from point k along the line, backwards (dir -1) or forwards (1). */
function pointFrom(coords: LonLat[], cum: number[], k: number, dir: 1 | -1, dist: number): LonLat {
  const target = cum[k] + dir * dist;
  let i = k;
  while (i + dir >= 0 && i + dir < coords.length && (dir === 1 ? cum[i + dir] < target : cum[i + dir] > target)) i += dir;
  const j = i + dir;
  if (j < 0 || j >= coords.length) return coords[i];
  const span = cum[j] - cum[i];
  const t = span ? (target - cum[i]) / span : 0;
  return [coords[i][0] + (coords[j][0] - coords[i][0]) * t, coords[i][1] + (coords[j][1] - coords[i][1]) * t];
}

/** The change of direction at point k (degrees, right positive), from the way in over the last
 *  30 m to the way out over the next 30 m. */
function turnAngle(coords: LonLat[], cum: number[], k: number): number {
  const into = bearing(pointFrom(coords, cum, k, -1, 30), coords[k]);
  const out = bearing(coords[k], pointFrom(coords, cum, k, 1, 30));
  return ((out - into + 540) % 360) - 180;
}

function classify(a: number): Turn {
  const x = Math.abs(a);
  const side = a > 0 ? 'right' : 'left';
  if (x < 20) return 'straight';
  if (x < 45) return `slight-${side}`;
  if (x < 135) return side;
  if (x < 170) return `sharp-${side}`;
  return 'uturn';
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const onto = (road: string | null) => (road ? ` onto ${road}` : '');
const TURN_WORDS: Record<Turn, string> = {
  straight: 'Go straight',
  'slight-left': 'Keep left',
  'slight-right': 'Keep right',
  left: 'Turn left',
  right: 'Turn right',
  'sharp-left': 'Turn sharp left',
  'sharp-right': 'Turn sharp right',
  uturn: 'Make a U-turn',
};

/**
 * The instructions for a route drawn along `coords` with its road stretches: where you set off,
 * each turn at a junction (by the change of direction; going straight on the same road needs none),
 * a change of road straight on ("Continue onto road 26"), roundabouts with the exit to take,
 * waypoints and the arrival. A bend at a junction where the road itself carries on is left out.
 */
export function maneuvers(coords: LonLat[], segs: RoadSeg[], dest: string): Maneuver[] {
  const cum = cumulative(coords);
  const out: Maneuver[] = [];
  const add = (m: Omit<Maneuver, 'along'>) => out.push({ ...m, along: cum[m.index] });
  const first = roadLabel(segs[0]?.name ?? null);
  const heading = COMPASS[Math.round(bearing(coords[0], pointFrom(coords, cum, 0, 1, 50)) / 45) % 8];
  add({ index: 0, kind: 'depart', road: first, text: `Head ${heading}${first ? ` on ${first}` : ''}` });
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const k = s.start;
    if (s.via) {
      add({ index: k, kind: 'via', via: s.via, road: roadLabel(s.name), text: `Waypoint ${s.via}` });
      continue;
    }
    // A roundabout: each stretch on it passes one exit; the instruction names the exit and the road
    // after it, and the stretches on it and the way off need no instructions of their own.
    if (s.type === ROUNDABOUT && segs[i - 1].type !== ROUNDABOUT) {
      let j = i;
      while (j < segs.length && segs[j].type === ROUNDABOUT) j++;
      const exit = j - i;
      const road = roadLabel(segs[j]?.name ?? null);
      add({ index: k, kind: 'roundabout', exit, road, text: `At the roundabout, take the ${ordinal(exit)} exit${onto(road)}` });
      // The way off the roundabout needs no turn of its own, but may be where a waypoint is.
      if (segs[j]?.via) add({ index: segs[j].start, kind: 'via', via: segs[j].via, road, text: `Waypoint ${segs[j].via}` });
      i = j;
      continue;
    }
    if (s.type === ROUNDABOUT) continue;
    const road = roadLabel(s.name);
    const changed = road !== roadLabel(segs[i - 1].name);
    // A choice to make: a junction, or a different road (a junction the network can miss where
    // one-way streets and dual carriageways meet).
    if (!s.junction && !changed) continue;
    const angle = turnAngle(coords, cum, k);
    const turn = classify(angle);
    if (turn === 'straight') {
      if (changed && road) add({ index: k, kind: 'continue', turn, road, text: `Continue onto ${road}` });
      continue;
    }
    // The same road bending at a junction: no instruction unless it's a real turn off the straight
    // way (then "Turn left to stay on road 1").
    if (!changed && Math.abs(angle) < 60) continue;
    const kind = turn.startsWith('slight') ? 'keep' : 'turn';
    const text = changed ? `${TURN_WORDS[turn]}${onto(road)}` : `${TURN_WORDS[turn]} to stay on ${road ?? 'this road'}`;
    add({ index: k, kind, turn, road, text });
  }
  add({ index: coords.length - 1, kind: 'arrive', road: null, text: `Arrive at ${dest}` });
  // Two turns within 20 m of each other: the second is the one that matters. Waypoints, roundabouts,
  // setting off and arriving always stay.
  const turnish = (m: Maneuver) => m.kind === 'turn' || m.kind === 'keep' || m.kind === 'continue';
  return out.filter((m, i) => !(turnish(m) && i + 1 < out.length && turnish(out[i + 1]) && out[i + 1].along - m.along < 20));
}
