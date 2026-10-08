/**
 * The roundabout icon for an exit at `angle` (degrees relative to the way in, right positive, as
 * Maneuver.exitAngle): the way in from below, the part of the ring you drive bold, and an arrow
 * out where the exit is, the rest of the ring faint. Traffic goes round anticlockwise (driving on
 * the right, as in Iceland), so a right exit is a quarter of the way round, a left one three.
 */

const C = 28; // the 56 × 56 icon's middle (x)
const CY = 24; // the ring's centre (y): a little high, leaving room for exits down beside the way in
const RING = 8;
const ARM = 21; // how far out from the centre the exit arrow reaches (inside the icon)
const HEAD = 7; // arrowhead length
/** How close round the ring to the way in an exit is drawn (degrees), so its arrow never lies on
 *  the way in: a sharp right exit at least this far, back the way you came at most 360 minus it. */
const MIN_GAP = 45;

const pt = (deg: number, r: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), CY - r * Math.cos(a)];
};
const f = (n: number) => Math.round(n * 10) / 10;
const xy = ([x, y]: [number, number]) => `${f(x)} ${f(y)}`;

/** How far round the ring (degrees, anticlockwise from the way in) the exit at `angle` is. */
export function sweepFor(angle: number): number {
  const a = ((((angle + 180) % 360) + 360) % 360) - 180; // −180..180
  return Math.min(360 - MIN_GAP, Math.max(MIN_GAP, 180 - a));
}

export function roundaboutIcon(angle: number): string {
  const sweep = sweepFor(angle);
  // Positions on the ring are compass angles from the top (0) clockwise; the way in is at 180.
  const out = 180 - sweep;
  const entry = pt(180, RING);
  const exit = pt(out, RING);
  const tip = pt(out, ARM);
  const back = (side: 1 | -1) => {
    const a = ((out + side * 150) * Math.PI) / 180;
    return [tip[0] + HEAD * Math.sin(a), tip[1] - HEAD * Math.cos(a)] as [number, number];
  };
  const large = sweep > 180 ? 1 : 0;
  return `<svg viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">`
    + `<circle cx="${C}" cy="${CY}" r="${RING}" stroke-width="3" opacity="0.4"/>`
    + `<path stroke-width="6" d="M${C} 53V${f(entry[1])}A${RING} ${RING} 0 ${large} 0 ${xy(exit)}L${xy(tip)}M${xy(back(1))}L${xy(tip)}L${xy(back(-1))}"/>`
    + `</svg>`;
}
