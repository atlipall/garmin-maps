import { describe, expect, test } from 'vitest';
import { roundaboutIcon, sweepFor } from '../src/ui/roundaboutIcon';

/** Where the exit arrow's tip is, from the icon's bold path ("…L<x> <y>M…"). */
const tip = (svg: string) => /L([\d.]+) ([\d.]+)M/.exec(svg)!.slice(1).map(Number);

describe('roundaboutIcon', () => {
  test('driving on the right, anticlockwise: right exit a quarter round, straight half, left three quarters', () => {
    expect(sweepFor(90)).toBe(90);
    expect(sweepFor(0)).toBe(180);
    expect(sweepFor(-90)).toBe(270);
  });

  test('a sharp right exit comes first, back the way you came last; neither lies on the way in', () => {
    expect(sweepFor(170)).toBe(45);
    expect(sweepFor(180)).toBe(315);
    expect(sweepFor(-180)).toBe(315);
  });

  test('the arrow points where the exit is: right, up (straight on), left', () => {
    expect(tip(roundaboutIcon(90))).toEqual([49, 24]);
    expect(tip(roundaboutIcon(0))).toEqual([28, 3]);
    expect(tip(roundaboutIcon(-90))).toEqual([7, 24]);
  });

  test('every angle stays inside the icon', () => {
    for (let a = -180; a <= 180; a += 5) {
      const nums = [...roundaboutIcon(a).matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...nums)).toBeLessThanOrEqual(56);
    }
  });

  test('the way in comes from below; more than half round takes the long arc', () => {
    expect(roundaboutIcon(0)).toContain('M28 53V32A8 8 0 0 0 28 16');
    expect(roundaboutIcon(-90)).toContain('A8 8 0 1 0 20 24');
  });
});
