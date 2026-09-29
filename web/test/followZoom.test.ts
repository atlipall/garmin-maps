import { describe, expect, test } from 'vitest';
import { zoomForSpeed } from '../src/location/followZoom';

const kmh = (v: number) => v / 3.6;

describe('zoomForSpeed', () => {
  test('walking 16, town driving 15, country 14, fast roads 13', () => {
    expect(zoomForSpeed(kmh(4), null)).toBe(16);
    expect(zoomForSpeed(kmh(20), null)).toBe(15);
    expect(zoomForSpeed(kmh(45), null)).toBe(14);
    expect(zoomForSpeed(kmh(90), null)).toBe(13);
  });

  test('unknown speed keeps the current follow zoom (or walking zoom to start)', () => {
    expect(zoomForSpeed(null, 14)).toBe(14);
    expect(zoomForSpeed(null, null)).toBe(16);
  });

  test('hysteresis: hovering around a boundary does not flip the zoom', () => {
    // Boundary 30 km/h between 15 and 14.
    expect(zoomForSpeed(kmh(31), 15)).toBe(15); // not clearly above yet
    expect(zoomForSpeed(kmh(36), 15)).toBe(14);
    expect(zoomForSpeed(kmh(29), 14)).toBe(14); // not clearly below yet
    expect(zoomForSpeed(kmh(24), 14)).toBe(15);
    // Big jumps skip bands.
    expect(zoomForSpeed(kmh(100), 16)).toBe(13);
    expect(zoomForSpeed(kmh(2), 13)).toBe(16);
  });
});
