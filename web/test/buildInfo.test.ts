import { expect, test } from 'vitest';
import { versionLabel } from '../src/buildInfo';

test('the menu shows the commit and the build time', () => {
  const label = versionLabel('feeaa6c', '2026-09-30T14:05:00Z');
  expect(label).toMatch(/^Version feeaa6c · 30 Sept? 2026, \d\d:\d\d$/);
});
