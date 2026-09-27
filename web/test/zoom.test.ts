import { expect, test } from 'vitest';
import { contourLabel, pyRound, zoomBands } from '../src/map/zoom';

test('zoom bands start the coarsest level at 4', () => {
  expect([...zoomBands([18, 20, 22, 24, 24, 20])]).toEqual([[18, [4, 8]], [20, [9, 10]], [22, [11, 12]], [24, [13, 14]]]);
  expect([...zoomBands([24])]).toEqual([[24, [4, 14]]]);
});

test('python-style rounding and contour labels', () => {
  expect([pyRound(2.5), pyRound(3.5), pyRound(-2.5), pyRound(1491.08)]).toEqual([2, 4, -2, 1491]);
  expect(contourLabel('328')).toBe('100');
  expect(contourLabel('Hekla')).toBe('Hekla');
});
