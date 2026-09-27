import { describe, expect, test } from 'vitest';
import { ascii, mapUnitsToDeg, s16, s24, u16, u24, u32 } from '../src/img/bytes';
import { BlobSource } from '../src/img/source';

const b = new Uint8Array([0x34, 0x12, 0xff, 0xff, 0x80, 0x01, 0x02, 0x03, 0x04, 0x47, 0x41]);

describe('bytes', () => {
  test('little-endian readers', () => {
    expect(u16(b, 0)).toBe(0x1234);
    expect(s16(b, 2)).toBe(-1);
    expect(u24(b, 5)).toBe(0x030201);
    expect(s24(b, 2)).toBe(-0x7f0001);
    expect(u32(b, 5)).toBe(0x04030201);
    expect(u32(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0)).toBe(0xffffffff);
    expect(ascii(b, 9, 11)).toBe('GA');
    expect(mapUnitsToDeg(1 << 23)).toBe(180);
  });

  test('out-of-range reads throw RangeError', () => {
    expect(() => u16(b, 10)).toThrow(RangeError);
    expect(() => u24(b, -1)).toThrow(RangeError);
  });

  test('BlobSource reads ranges', async () => {
    const src = new BlobSource(new Blob([b]));
    expect(src.size).toBe(11);
    expect([...(await src.read(1, 3))]).toEqual([0x12, 0xff, 0xff]);
  });
});
