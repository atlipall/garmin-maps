import { describe, expect, test } from 'vitest';
import type { LonLat, RouteReply } from '../src/routing/plan';
import { bestInsert, joinLegs } from '../src/routing/waypoints';

type RouteOk = Extract<RouteReply, { status: 'ok' }>;
const leg = (coords: LonLat[], metres: number, seconds: number, extra: Partial<RouteOk> = {}): RouteOk => ({
  status: 'ok', coords, metres, seconds, offRoadStart: null, offRoadEnd: null, offRoadStartM: 0, offRoadEndM: 0, ...extra,
});

describe('bestInsert', () => {
  // Start at 0°, a waypoint at 1°, destination at 2° east, all on the equator.
  const stops: LonLat[] = [[0, 0], [1, 0], [2, 0]];
  test('a point along the way goes between the stops it lies between', () => {
    expect(bestInsert(stops, [0.5, 0.01])).toBe(0);
    expect(bestInsert(stops, [1.5, -0.01])).toBe(1);
  });
  test('with no waypoints yet it goes between start and destination', () => {
    expect(bestInsert([[0, 0], [2, 0]], [1, 0.3])).toBe(0);
  });
});

describe('joinLegs', () => {
  test('lines joined without repeating the shared point; distance and time added up', () => {
    const r = joinLegs([leg([[0, 0], [1, 0]], 1000, 60), leg([[1, 0], [2, 0]], 2000, 90)]);
    expect(r.coords).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(r.metres).toBe(3000);
    expect(r.seconds).toBe(150);
    expect(r.offRoadVia).toEqual([]);
  });
  test('off-road legs at the ends stay, those at waypoints are listed separately', () => {
    const s: [LonLat, LonLat] = [[-0.1, 0], [0, 0]];
    const toWp: [LonLat, LonLat] = [[1, 0], [1, 0.1]];
    const fromWp: [LonLat, LonLat] = [[1, 0.1], [1, 0]];
    const e: [LonLat, LonLat] = [[2, 0], [2.1, 0]];
    const r = joinLegs([
      leg([[0, 0], [1, 0]], 1000, 60, { offRoadStart: s, offRoadStartM: 11, offRoadEnd: toWp, offRoadEndM: 12 }),
      leg([[1, 0], [2, 0]], 2000, 90, { offRoadStart: fromWp, offRoadStartM: 12, offRoadEnd: e, offRoadEndM: 13 }),
    ]);
    expect([r.offRoadStart, r.offRoadStartM, r.offRoadEnd, r.offRoadEndM]).toEqual([s, 11, e, 13]);
    expect(r.offRoadVia).toEqual([toWp, fromWp]);
  });
});
