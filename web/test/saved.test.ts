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
  });

  test('damaged or unknown entries are left out', () => {
    expect(isSaved(null)).toBe(false);
    expect(isSaved({ ...pin, lat: 'x' })).toBe(false);
    expect(isSaved({ ...pin, kind: 'track' })).toBe(false);
    expect(isSaved({ ...route, from: [1] })).toBe(false);
    expect(isSaved({ ...route, route: { ...route.route, coords: [[1, 2]] } })).toBe(false);
    expect(isSaved({ ...route, route: { status: 'no-route' } })).toBe(false);
  });
});
