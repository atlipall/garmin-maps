import { describe, expect, test } from 'vitest';
import { decodeNumbers, parseTrip, tripGpx, tripId, tripName } from '../src/tracks/trip';

/** Made by the Android app's own encoder (android/.../Trip.java): 60 fixes north at ~15 m/s, a turn
 *  east, 20 more, then a point in Sydney (negative latitude, large steps). */
const FROM_ANDROID = '#trip=1.1791237600000.1791237695000.onhfKnkrdC%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B?Y?%5B??%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@?%7B@jz%60uQw%7Bm_%60@.GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAK';

describe('a trip handed over by the Android app', () => {
  test('reads the points and times the app wrote', () => {
    const trip = parseTrip(FROM_ANDROID)!;
    expect(trip.start).toBe(1791237600000);
    expect(trip.end).toBe(1791237695000);
    expect(trip.points).toHaveLength(81);
    expect(trip.points[0]).toEqual({ lat: 64.11, lon: -21.89, ele: null, time: 1791237604000 });
    expect(trip.points[59]).toMatchObject({ lat: 64.11797, lon: -21.89, time: 1791237663000 });
    expect(trip.points[60]).toMatchObject({ lat: 64.11797, lon: -21.8897, time: 1791237665000 });
    expect(trip.points[80]).toEqual({ lat: -33.86785, lon: 151.20732, ele: null, time: 1791237690000 });
  });

  test('anything else in the address is not a trip', () => {
    expect(parseTrip('')).toBeNull();
    expect(parseTrip('#map=12/64/-21')).toBeNull();
    expect(parseTrip('#trip=2.1.2.a.b')).toBeNull(); // a format this version doesn't know
    expect(parseTrip('#trip=1.1.2.%7B.?')).toBeNull(); // a number cut short
    expect(parseTrip('#trip=1.1.2.??.')).toBeNull(); // points without times
    expect(parseTrip('#trip=1.1.2.%E0%A4%A.?')).toBeNull(); // a broken %-escape
  });

  test('an empty trip has no points', () => {
    expect(parseTrip('#trip=1.5.9..')).toEqual({ start: 5, end: 9, points: [] });
  });

  test('encoded-polyline numbers, including the classic example', () => {
    // Google's documented example: -179.9832104 → `~oia@`.
    expect(decodeNumbers('`~oia@')).toEqual([-17998321]);
    expect(decodeNumbers('?')).toEqual([0]);
    expect(decodeNumbers('@')).toEqual([-1]);
    expect(decodeNumbers('A')).toEqual([1]);
    expect(decodeNumbers('_ibE')).toEqual([100000]);
  });

  test('suggested name, GPX and id', () => {
    const start = new Date(2026, 9, 5, 14, 20).getTime();
    const end = new Date(2026, 9, 5, 14, 31).getTime();
    expect(tripName(start, end)).toBe('Drive 5 Oct, 14:20–14:31');
    const trip = { start, end, points: [{ lat: 64, lon: -21, ele: null, time: start }] };
    expect(tripGpx(trip, 'Home')).toEqual({ name: 'Home', lines: [{ kind: 'track', name: 'Home', points: trip.points }], waypoints: [] });
    expect(tripId(trip)).toBe(tripId({ ...trip, end: end + 1 }));
  });
});
