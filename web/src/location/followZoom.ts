/** Follow zoom by speed: close in on foot, further out the faster you go, so the road ahead
 *  stays on screen for a similar time. Zooms are MapLibre zoom levels (16 ≈ a 100 m scale bar). */
const BANDS: Array<{ from: number; zoom: number }> = [
  { from: 0, zoom: 16 },
  { from: 7 / 3.6, zoom: 15 },
  { from: 30 / 3.6, zoom: 14 },
  { from: 60 / 3.6, zoom: 13 },
];
/** Speed must clear a boundary by this fraction before the zoom changes (no flip-flopping). */
const MARGIN = 0.15;

export const WALK_ZOOM = BANDS[0].zoom;

const bandOf = (speed: number) => BANDS.reduce((b, band, i) => (speed >= band.from ? i : b), 0);

/** The follow zoom for `speed` (m/s, null when unknown), given the current follow zoom (null at
 *  start). Leaving the current band needs a speed clearly beyond its boundary. */
export function zoomForSpeed(speed: number | null, current: number | null): number {
  if (speed === null || !Number.isFinite(speed)) return current ?? WALK_ZOOM;
  const target = bandOf(speed);
  const now = current === null ? -1 : BANDS.findIndex((b) => b.zoom === current);
  if (now < 0) return BANDS[target].zoom;
  if (target > now && speed < BANDS[now + 1].from * (1 + MARGIN)) return BANDS[now].zoom;
  if (target < now && speed >= BANDS[now].from * (1 - MARGIN)) return BANDS[now].zoom;
  return BANDS[target].zoom;
}
