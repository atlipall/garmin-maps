import { describe, expect, test } from 'vitest';
import { isSaved, type SavedPin, type SavedRoute } from '../src/saved/saved';

const pin: SavedPin = { id: 'a', kind: 'pin', name: 'Hut', added: 1, lon: -19.06, lat: 63.99 };
const route: SavedRoute = {
  id: 'b',
  kind: 'route',
  name: 'To Landmannalaugar',
  added: 2,
  dest: { name: 'Landmannalaugar', lon: -19.06, lat: 63.991 },
  from: [-21, 63.94],
  allowFRoads: true,
  preferFRoads: false,
  route: { status: 'ok', coords: [[-21, 63.94], [-19.06, 63.991]], metres: 125_000, seconds: 7600, offRoadStart: null, offRoadEnd: null, offRoadStartM: 0, offRoadEndM: 0 },
};

describe('isSaved', () => {
  test('saved pins and routes as stored', () => {
    expect(isSaved(pin)).toBe(true);
    expect(isSaved(route)).toBe(true);
    expect(isSaved({ ...route, vias: [{ name: null, lon: -20.4, lat: 63.83, near: 'Hella' }], route: { ...route.route, offRoadVia: [] } })).toBe(true);
  });

  test('damaged or unknown entries are left out', () => {
    expect(isSaved(null)).toBe(false);
    expect(isSaved({ ...pin, lat: 'x' })).toBe(false);
    expect(isSaved({ ...pin, kind: 'track' })).toBe(false);
    expect(isSaved({ ...route, from: [1] })).toBe(false);
    expect(isSaved({ ...route, route: { ...route.route, coords: [[1, 2]] } })).toBe(false);
    expect(isSaved({ ...route, route: { status: 'no-route' } })).toBe(false);
    expect(isSaved({ ...route, vias: [{ lon: 'x' }] })).toBe(false);
    // Road stretches must fit their line: one starting outside it would hang turn-by-turn.
    const segs = (start: number) => ({ ...route, route: { ...route.route, segs: [{ start, name: '1', type: 1, junction: true, seconds: 10 }] } });
    expect(isSaved(segs(0))).toBe(true);
    expect(isSaved(segs(-1e308))).toBe(false);
    expect(isSaved(segs(5))).toBe(false);
    expect(isSaved({ ...route, route: { ...route.route, segs: [{ start: 0, name: 7, type: 1, junction: true, seconds: 10 }] } })).toBe(false);
    expect(isSaved({ ...route, route: { ...route.route, offRoadEnd: [[1, 2]] } })).toBe(false);
  });
});
