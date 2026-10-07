/** Follow zoom by speed: close in on foot, further out the faster you go. The scale (metres per
 *  screen pixel) follows Organic Maps' 2D auto zoom (drape_frontend/my_position_controller.cpp,
 *  CalculateZoomBySpeed: 0.7 m/px up to 20 km/h ... 6 m/px from 95 km/h), with a walking point
 *  added at the closer zoom this app uses on foot; between points it is interpolated. OsmAnd aims
 *  for a similar look-ahead (about 30 s of driving on screen). Zooms are MapLibre zoom levels
 *  (16 ≈ a 100 m scale bar). */
const SCALE: ReadonlyArray<readonly [kmh: number, metresPerPixel: number]> = [
  [5, 0.5],
  [20, 0.7],
  [40, 1.25],
  [60, 2.25],
  [75, 3.0],
  [85, 3.75],
  [95, 6.0],
];
/** The follow zoom moves in half-zoom steps (a scale change, not a drift with every GPS fix)... */
const STEP = 0.5;
/** ...and only once the ideal zoom is this far past the halfway mark (no flip-flopping). */
const MARGIN = 0.15;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** MapLibre's tiles are 512 px wide at their zoom level. */
const TILE_PX = 512;

export const WALK_ZOOM = 16;

/** The scale for `kmh`: interpolated between the table's points, held at its ends. */
export function metresPerPixel(kmh: number): number {
  if (kmh <= SCALE[0][0]) return SCALE[0][1];
  for (let i = 1; i < SCALE.length; i++) {
    const [v1, m1] = SCALE[i];
    if (kmh <= v1) {
      const [v0, m0] = SCALE[i - 1];
      return m0 + ((kmh - v0) / (v1 - v0)) * (m1 - m0);
    }
  }
  return SCALE[SCALE.length - 1][1];
}

/** The MapLibre zoom showing `mpp` metres per pixel at latitude `lat` (Web Mercator stretches the
 *  map away from the equator, so in Iceland a zoom shows less than half the ground it does there). */
export function zoomForScale(mpp: number, lat: number): number {
  return Math.log2((EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * mpp));
}

/** The follow zoom for `speed` (m/s, null when unknown) at latitude `lat`, given the current follow
 *  zoom (null at start): the nearest half step to the ideal zoom, kept while the ideal stays within
 *  half a step (plus a margin) of the current one. */
export function zoomForSpeed(speed: number | null, current: number | null, lat: number): number {
  if (speed === null || !Number.isFinite(speed)) return current ?? WALK_ZOOM;
  const ideal = zoomForScale(metresPerPixel(Math.max(0, speed) * 3.6), lat);
  if (current !== null && Math.abs(ideal - current) < STEP / 2 + MARGIN) return current;
  return Math.round(ideal / STEP) * STEP;
}
