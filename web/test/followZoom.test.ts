import { describe, expect, test } from 'vitest';
import { metresPerPixel, zoomForScale, zoomForSpeed } from '../src/location/followZoom';

const kmh = (v: number) => v / 3.6;
const RVK = 64.14; // Reykjavík

describe('metresPerPixel', () => {
  test("Organic Maps' scale by speed, interpolated, held at the ends", () => {
    expect(metresPerPixel(0)).toBe(0.5);
    expect(metresPerPixel(20)).toBe(0.7);
    expect(metresPerPixel(30)).toBeCloseTo(0.975, 9); // halfway from 0.7 to 1.25
    expect(metresPerPixel(60)).toBe(2.25);
    expect(metresPerPixel(95)).toBe(6);
    expect(metresPerPixel(130)).toBe(6);
  });
});

describe('zoomForScale', () => {
  test('the same scale needs a closer zoom away from the equator', () => {
    // At the equator zoom 16 is about 1.19 m/px (40 075 km / (512 · 2^16)).
    expect(zoomForScale(40_075_016.686 / (512 * 2 ** 16), 0)).toBeCloseTo(16, 9);
    expect(zoomForScale(1, RVK)).toBeLessThan(zoomForScale(1, 0) - 1);
  });
});

describe('zoomForSpeed', () => {
  test('in Reykjavík: walking 16, town 15.5, country road 14.5, 60 km/h 14, 90 km/h 13, faster 12.5', () => {
    expect(zoomForSpeed(kmh(4), null, RVK)).toBe(16);
    expect(zoomForSpeed(kmh(20), null, RVK)).toBe(15.5);
    expect(zoomForSpeed(kmh(45), null, RVK)).toBe(14.5);
    expect(zoomForSpeed(kmh(60), null, RVK)).toBe(14);
    expect(zoomForSpeed(kmh(90), null, RVK)).toBe(13);
    expect(zoomForSpeed(kmh(110), null, RVK)).toBe(12.5);
  });

  test('unknown speed keeps the current follow zoom (or walking zoom to start)', () => {
    expect(zoomForSpeed(null, 14, RVK)).toBe(14);
    expect(zoomForSpeed(null, null, RVK)).toBe(16);
  });

  test('hysteresis: hovering around a step does not flip the zoom; big changes jump', () => {
    // 60 km/h is about zoom 13.9: from 14 a little faster or slower keeps 14.
    expect(zoomForSpeed(kmh(55), 14, RVK)).toBe(14);
    expect(zoomForSpeed(kmh(66), 14, RVK)).toBe(14);
    // Clearly faster: the next step out.
    expect(zoomForSpeed(kmh(80), 14, RVK)).toBe(13.5);
    // Big jumps skip steps.
    expect(zoomForSpeed(kmh(110), 16, RVK)).toBe(12.5);
    expect(zoomForSpeed(kmh(2), 12.5, RVK)).toBe(16);
  });

  test('standing still is the walking zoom, as before', () => {
    expect(zoomForSpeed(0, 14, RVK)).toBe(16);
  });
});
