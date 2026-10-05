import { describe, expect, test } from 'vitest';
import type { StoredTrack } from '../src/gpx/store';
import { maneuvers } from '../src/routing/maneuvers';
import type { LonLat, RoadSeg, RouteReply } from '../src/routing/plan';
import { nearestAhead, routeAlongTrack, trackLine } from '../src/tracks/plan';

const M_LAT = 1 / 111_195;
const M_LON = M_LAT / Math.cos((64 * Math.PI) / 180);
const at = (e: number, n: number): LonLat => [-19 + e * M_LON, 64 + n * M_LAT];
const pt = ([lon, lat]: LonLat, time: number | null = null) => ({ lon, lat, ele: null, time });

/** A track going east 1 km, north 500 m, then back west 1 km (a U: its last leg passes 500 m
 *  north of its first). */
function uTrack(): StoredTrack {
  const pts = [
    ...[0, 250, 500, 750, 1000].map((e) => at(e, 0)),
    at(1000, 250), at(1000, 500),
    ...[750, 500, 250, 0].map((e) => at(e, 500)),
  ];
  return { id: 't', name: 'U', color: '#000', visible: true, added: 1, stats: { distance: 2500, climb: null, duration: null } as StoredTrack['stats'], gpx: { name: 'U', lines: [{ kind: 'track', name: null, points: [pts[0], ...pts].map((p) => pt(p)) }], waypoints: [] } };
}

describe('the track line', () => {
  test('repeated points dropped; turned round for reverse (without its recorded times)', () => {
    const t = uTrack();
    const line = trackLine(t, false);
    expect(line.coords).toHaveLength(11);
    expect(line.cum[line.cum.length - 1]).toBeCloseTo(2500, -1);
    const back = trackLine(t, true);
    expect(back.coords[0]).toEqual(line.coords[10]);
    expect(back.times.every((x) => x === null)).toBe(true);
  });
});

describe('nearestAhead', () => {
  test('the nearest point, but not on a part already behind you', () => {
    const line = trackLine(uTrack(), false);
    // 100 m north of the first leg, 400 m south of the last: the first leg is nearest…
    const p = at(500, 100);
    const first = nearestAhead(line, p);
    expect(first.along).toBeCloseTo(500, 0);
    expect(first.off).toBeCloseTo(100, 0);
    // …but once past 1.2 km along, the last leg it is.
    const later = nearestAhead(line, p, 1200);
    expect(later.along).toBeCloseTo(2000, 0);
    expect(later.off).toBeCloseTo(400, 0);
  });
});

describe('routeAlongTrack', () => {
  const line = trackLine(uTrack(), false);
  const segs: RoadSeg[] = [
    { start: 0, name: 'F208', type: 0x0a, junction: false, seconds: 100 },
    { start: 6, name: null, type: 0, junction: true, seconds: 1500, trail: true },
  ];

  test('on the track: the rest of it, from the nearest point, with its own turns and time', () => {
    // Within a few metres of it, navigation starts right on it (no walk to it, no "Join").
    const join = nearestAhead(line, at(500, 10));
    const { route, approachM } = routeAlongTrack('U', line, segs, join, null, null);
    expect(approachM).toBe(0);
    // F208's stretch runs to 1,500 m (the trail starts at the top of the U): 1,000 m of it is still
    // ahead, then all of the trail.
    expect(route.seconds).toBeCloseTo(100 * (1000 / 1500) + 1500, 0);
    expect(maneuvers(route.coords, route.segs!, 'the end').map((m) => m.text)).toEqual(['Head east on F208', 'Turn left onto the trail', 'Arrive at the end']);
  });

  test('from afar: the planned way to the track, then "Join", then the track', () => {
    const join = nearestAhead(line, at(500, -3000));
    const road: Extract<RouteReply, { status: 'ok' }> = {
      status: 'ok', coords: [at(500, -2900), at(500, -50)], metres: 2850, seconds: 120,
      offRoadStart: [at(500, -3000), at(500, -2900)], offRoadEnd: [at(500, -50), join.point], offRoadStartM: 100, offRoadEndM: 50,
      segs: [{ start: 0, name: '26', type: 0x02, junction: false, seconds: 120 }],
    };
    const { route, approachM } = routeAlongTrack('U', line, segs, join, at(500, -3000), road);
    expect(approachM).toBeCloseTo(3000, -1);
    expect(route.coords[0]).toEqual(at(500, -3000));
    const steps = maneuvers(route.coords, route.segs!, 'the end').map((m) => m.text);
    expect(steps[0]).toBe('Head north'); // the straight leg to the road has no name
    expect(steps).toContain('Continue onto road 26');
    expect(steps).toContain('Join U');
    expect(steps[steps.length - 1]).toBe('Arrive at the end');
  });
});
