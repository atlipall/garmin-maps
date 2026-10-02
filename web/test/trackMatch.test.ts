import { describe, expect, test } from 'vitest';
import { UNITS_PER_DEG } from '../src/routing/graph';
import { maneuvers } from '../src/routing/maneuvers';
import type { LonLat } from '../src/routing/plan';
import type { RoadLine, RoadLines } from '../src/routing/snap';
import { matchTrack } from '../src/tracks/match';

const M_LAT = 1 / 111_195; // degrees of latitude per metre
const LAT = 64;
const M_LON = M_LAT / Math.cos((LAT * Math.PI) / 180);
/** A point `e` metres east and `n` north of (-19, 64). */
const at = (e: number, n: number): LonLat => [-19 + e * M_LON, LAT + n * M_LAT];
const units = (p: LonLat): [number, number] => [p[0] * UNITS_PER_DEG, p[1] * UNITS_PER_DEG];

/** F208 running east for 2 km; every request gets the one line. */
const F208: RoadLine = { tile: 0, net: 1, cls: 1, name: 'F208', type: 0x0a, coords: [at(0, 0), at(2000, 0)].map(units) };
const lines: RoadLines = async () => [F208];

/** A track: 1 km east along F208 (with a little GPS wobble), north off it onto a trail for 400 m,
 *  then a sharp turn to the south-east for 300 m. Points every 20 m. */
function track(): LonLat[] {
  const pts: LonLat[] = [];
  for (let e = 0; e <= 1000; e += 20) pts.push(at(e, e === 500 ? 8 : 3));
  for (let n = 20; n <= 400; n += 20) pts.push(at(1000, n));
  for (let d = 20; d <= 300; d += 20) pts.push(at(1000 + d * 0.8, 400 - d * 0.6));
  return pts;
}

describe('matchTrack', () => {
  test('a track gets its road, the trail it leaves onto, and the trail\'s sharp bend', async () => {
    const coords = track();
    const segs = await matchTrack(coords, lines);
    expect(segs.map((s) => [s.name, !!s.trail, !!s.bend, s.junction])).toEqual([
      ['F208', false, false, false],
      [null, true, false, true],
      [null, true, true, true],
    ]);
    // Driven on F208 (an F-road: 40 km/h), walked on the trail.
    expect(segs[0].seconds).toBeCloseTo(1000 / (40 / 3.6), -1);
    expect(segs[1].seconds).toBeGreaterThan(300);
    const steps = maneuvers(coords, segs, 'Hrafntinnusker').map((m) => m.text);
    expect(steps).toEqual(['Head east on F208', 'Turn left onto the trail', 'Turn right on the trail', 'Arrive at Hrafntinnusker']);
  });

  test('recorded GPX times are used where the track has them', async () => {
    const coords = track();
    const start = Date.UTC(2026, 6, 1, 9);
    const times = coords.map((_, i) => start + i * 10_000); // 10 s per point
    const segs = await matchTrack(coords, lines, times);
    expect(segs[0].seconds).toBe(segs[1].start * 10);
  });

  test('a track wholly off the roads is one trail; a trail with gentle curves has no turns', async () => {
    const coords: LonLat[] = [];
    for (let i = 0; i <= 50; i++) coords.push(at(i * 20, 500 + Math.sin(i / 8) * 40));
    const segs = await matchTrack(coords, lines);
    expect(segs).toHaveLength(1);
    expect(segs[0].trail).toBe(true);
    expect(maneuvers(coords, segs, 'Hut').map((m) => m.kind)).toEqual(['depart', 'arrive']);
  });
});
