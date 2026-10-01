import { describe, expect, test } from 'vitest';
import { maneuvers, roadLabel, ROUNDABOUT } from '../src/routing/maneuvers';
import type { LonLat, RoadSeg } from '../src/routing/plan';
import { Progress } from '../src/routing/progress';

const seg = (start: number, name: string | null, extra: Partial<RoadSeg> = {}): RoadSeg => ({ start, name, type: 1, junction: true, seconds: 10, ...extra });
const kinds = (ms: ReturnType<typeof maneuvers>) => ms.map((m) => `${m.kind}: ${m.text}`);

describe('roadLabel', () => {
  test('numbers are roads, F-roads stay, capitals become normal case', () => {
    expect(roadLabel('26')).toBe('road 26');
    expect(roadLabel('F26')).toBe('F26');
    expect(roadLabel('SIGTÚN')).toBe('Sigtún');
    expect(roadLabel(null)).toBeNull();
  });
});

describe('maneuvers', () => {
  test('set off, turn left onto another road, arrive', () => {
    // North 222 m on road 1, then west on road 26.
    const coords: LonLat[] = [[0, 0], [0, 0.002], [-0.002, 0.002]];
    expect(kinds(maneuvers(coords, [seg(0, '1'), seg(1, '26')], 'Hut'))).toEqual([
      'depart: Head north on road 1',
      'turn: Turn left onto road 26',
      'arrive: Arrive at Hut',
    ]);
  });

  test('straight on through a junction: nothing on the same road, "Continue onto" when the road changes', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0, 0.004], [0, 0.006]];
    expect(kinds(maneuvers(coords, [seg(0, '1'), seg(1, '1'), seg(2, '35')], 'X'))).toEqual([
      'depart: Head north on road 1',
      'continue: Continue onto road 35',
      'arrive: Arrive at X',
    ]);
  });

  test('a roundabout: the exit to take is the number of stretches on it', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0.0003, 0.0023], [0.0006, 0.002], [0.0006, 0]];
    const segs = [seg(0, '1'), seg(1, null, { type: ROUNDABOUT }), seg(2, null, { type: ROUNDABOUT, junction: false }), seg(3, '1', { junction: false })];
    expect(kinds(maneuvers(coords, segs, 'X'))).toEqual([
      'depart: Head north on road 1',
      'roundabout: At the roundabout, take the 2nd exit onto road 1',
      'arrive: Arrive at X',
    ]);
  });

  test('the same road bending at a junction needs no instruction; a real turn to stay on it does', () => {
    const bend: LonLat[] = [[0, 0], [0, 0.002], [0.001, 0.004]]; // ~27° right
    expect(kinds(maneuvers(bend, [seg(0, '1'), seg(1, '1')], 'X')).map((k) => k.split(':')[0])).toEqual(['depart', 'arrive']);
    const corner: LonLat[] = [[0, 0], [0, 0.002], [0.002, 0.002]]; // 90° right
    expect(kinds(maneuvers(corner, [seg(0, '1'), seg(1, '1')], 'X'))[1]).toBe('turn: Turn right to stay on road 1');
  });

  test('a waypoint is its own instruction', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0, 0.004]];
    const ms = maneuvers(coords, [seg(0, '1'), seg(1, '1', { via: 1 })], 'X');
    expect(kinds(ms)[1]).toBe('via: Waypoint 1');
    expect(Math.round(ms[1].along)).toBe(222);
  });
});

describe('Progress', () => {
  // 0 → 222 m north (road 1, 20 s), then 222 m west (road 26, 60 s).
  const coords: LonLat[] = [[0, 0], [0, 0.002], [-0.002, 0.002]];
  const segs = [seg(0, '1', { seconds: 20 }), seg(1, '26', { seconds: 60 })];

  test('the nearest point along the route and how far off it you are', () => {
    const p = new Progress(coords, segs, 80);
    const w = p.locate([0.0005, 0.001]); // 55 m east of the first stretch, halfway up
    expect(Math.round(w.along)).toBe(111);
    expect(Math.round(w.off)).toBe(56);
  });

  test('distance and time left, from the road stretches\' times', () => {
    const p = new Progress(coords, segs, 80);
    const half = p.left(111.2);
    expect(Math.round(half.metres)).toBe(334);
    expect(Math.round(half.seconds)).toBe(70); // half of road 1 (10 s) + road 26 (60 s)
    expect(p.left(p.total).seconds).toBe(0);
  });
});
