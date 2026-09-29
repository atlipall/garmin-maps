/** Above this speed (m/s, ~7 km/h) the GPS course is used instead of the compass: it is accurate
 *  once moving, and a compass in a car is thrown off by the metal and electronics around it. */
export const DRIVING_SPEED = 7 / 3.6;
/** A compass reading older than this (ms) is ignored (sensor stopped, permission revoked). */
const COMPASS_MAX_AGE = 3000;

export interface HeadingInputs {
  /** Latest compass heading, degrees clockwise from north, and when it arrived (ms). */
  compass: { heading: number; time: number } | null;
  /** Latest GPS fix's course (degrees; null or NaN when not moving) and speed (m/s; null if unknown). */
  gps: { heading: number | null; speed: number | null };
  now: number;
}

const valid = (h: number | null | undefined): h is number => h != null && Number.isFinite(h);

/** Degrees clockwise from north that the user faces or moves, or null when unknown. */
export function chooseHeading({ compass, gps, now }: HeadingInputs): number | null {
  const fresh = compass && now - compass.time <= COMPASS_MAX_AGE ? compass.heading : null;
  if (valid(gps.heading) && (gps.speed ?? 0) >= DRIVING_SPEED) return gps.heading;
  if (valid(fresh)) return fresh;
  return valid(gps.heading) ? gps.heading : null;
}

/** Shortest signed turn from a to b, in degrees (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Moves `prev` a `factor` of the way towards `next` along the shorter arc (0 ≤ result < 360). */
export function smoothAngle(prev: number | null, next: number, factor: number): number {
  if (prev == null) return next;
  const v = prev + angleDelta(prev, next) * factor;
  return ((v % 360) + 360) % 360;
}
