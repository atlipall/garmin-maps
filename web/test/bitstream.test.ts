import { expect, test } from 'vitest';
import { decodeDeltas, setup } from '../src/img/bitstream';

const d = (bytes: number[], base: number, v2: boolean, extra: boolean) => decodeDeltas(new Uint8Array(bytes), base, v2, extra);

test('same sign positive', () => expect(d([0x95], 0x00, false, false)).toEqual([[1, 2]]));
test('same sign negative x', () => expect(d([0x97], 0x00, false, false)).toEqual([[-1, 2]]));
test('signed values', () => expect(d([0x7c], 0x00, false, false)).toEqual([[-1, 3]]));
test('signed escape extends magnitude', () => expect(d([0x50, 0x00], 0x00, false, false)).toEqual([[5, 0]]));
test('extra bit is skipped', () => expect(d([0x75, 0x05], 0x11, false, true)).toEqual([[3, 5]]));
test('v2 flag bit widens coords', () => {
  const [bx, by, sign] = setup(0x00, 0x05 | 0x10, true);
  expect([bx, by, sign.headerBits]).toEqual([3, 3, 5]);
});
test('v2 decode (trailing padding yields a zero delta)', () =>
  expect(d([0x25, 0x01], 0x00, true, false)).toEqual([[1, 2], [0, 0]]));
test('empty bitstream has no deltas', () => expect(d([], 0x00, false, false)).toEqual([]));
