import { describe, expect, test } from 'vitest';
import { angleDelta, chooseHeading, DRIVING_SPEED, smoothAngle } from '../src/location/heading';
import { compassReset, dragged, INITIAL, longPress, tap, type LocationState } from '../src/location/modes';

describe('location modes', () => {
  const s = (mode: LocationState['mode'], paused = false): LocationState => ({ mode, paused });

  test('tapping cycles off → follow north up → follow heading up → north up …', () => {
    expect(INITIAL).toEqual(s('off'));
    expect(tap(s('off'))).toEqual(s('north'));
    expect(tap(s('north'))).toEqual(s('heading'));
    expect(tap(s('heading'))).toEqual(s('north'));
  });

  test('dragging pauses following; the next tap resumes the same mode', () => {
    expect(dragged(s('north'))).toEqual(s('north', true));
    expect(dragged(s('heading'))).toEqual(s('heading', true));
    expect(dragged(s('off'))).toEqual(s('off'));
    expect(tap(s('heading', true))).toEqual(s('heading'));
    expect(tap(s('north', true))).toEqual(s('north'));
  });

  test('the compass returns heading-up to north-up; a long press turns location off', () => {
    expect(compassReset(s('heading'))).toEqual(s('north'));
    expect(compassReset(s('heading', true))).toEqual(s('north', true));
    expect(compassReset(s('north'))).toEqual(s('north'));
    expect(longPress()).toEqual(s('off'));
  });
});

describe('heading', () => {
  const now = 10_000;

  test('compass when slow or still, GPS course when driving', () => {
    const compass = { heading: 90, time: now - 500 };
    expect(chooseHeading({ compass, gps: { heading: 180, speed: 1 }, now })).toBe(90);
    expect(chooseHeading({ compass, gps: { heading: 180, speed: DRIVING_SPEED + 0.1 }, now })).toBe(180);
    expect(chooseHeading({ compass, gps: { heading: null, speed: 30 }, now })).toBe(90); // no course reported
  });

  test('a stale or missing compass falls back to GPS course, else no heading', () => {
    expect(chooseHeading({ compass: { heading: 90, time: now - 5000 }, gps: { heading: 45, speed: 0.5 }, now })).toBe(45);
    expect(chooseHeading({ compass: null, gps: { heading: null, speed: null }, now })).toBeNull();
    expect(chooseHeading({ compass: null, gps: { heading: Number.NaN, speed: 0 }, now })).toBeNull();
  });

  test('angles wrap around north', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
    expect(smoothAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(smoothAngle(null, 123, 0.2)).toBe(123);
    expect(smoothAngle(90, 100, 0.25)).toBeCloseTo(92.5, 6);
  });
});
