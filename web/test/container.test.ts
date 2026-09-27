import { describe, expect, test } from 'vitest';
import { ImgError } from '../src/img/bytes';
import { ImgContainer } from '../src/img/container';
import { BlobSource } from '../src/img/source';
import { buildImg, bytesOf } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const open = (bytes: Uint8Array) => ImgContainer.open(new BlobSource(new Blob([new Uint8Array(bytes)])));
const filled = (n: number, c: string) => new Uint8Array(n).fill(c.charCodeAt(0));

describe('ImgContainer', () => {
  test('reads subfiles', async () => {
    const img = await open(buildImg({ '00000001.TRE': filled(700, 'T'), '00000001.RGN': filled(10, 'R'), '103F2.TYP': filled(3, 'Y') }));
    expect(img.tileIds()).toEqual(['00000001']);
    expect(await img.read('00000001.TRE')).toEqual(filled(700, 'T'));
    expect(await img.read('00000001.TRE', 690, 20)).toEqual(filled(10, 'T'));
    expect(img.firstOfType('TYP')).toBe('103F2.TYP');
    expect(img.has('missing.XYZ')).toBe(false);
  });

  test('joins multi-part entries and reads across blocks', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => i % 256);
    const img = await open(buildImg({ 'A.RGN': data }, 512, 3));
    expect(await img.read('A.RGN')).toEqual(data);
    expect(await img.read('A.RGN', 500, 1100)).toEqual(data.subarray(500, 1600));
  });

  test('rejects non-IMG and scrambled images', async () => {
    await expect(open(new Uint8Array(4096))).rejects.toThrow(/DSKIMG/);
    const raw = buildImg({ 'A.TRE': bytesOf('x') });
    raw[0] = 0x5a;
    await expect(open(raw)).rejects.toThrow(/XOR/);
  });

  test('rejects duplicate part numbers', async () => {
    const raw = buildImg({ 'A.RGN': new Uint8Array(5120) }, 512, 3);
    raw[0x600 + 0x10] = 0;
    raw[0x600 + 0x11] = 0;
    await expect(open(raw)).rejects.toThrow(ImgError);
  });

  test('assembles parts stored out of order', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => (i * 7) % 256);
    const raw = buildImg({ 'A.RGN': data }, 512, 3);
    const a = raw.slice(0x600, 0x800);
    raw.set(raw.slice(0x800, 0xa00), 0x600);
    raw.set(a, 0x800);
    expect(await (await open(raw)).read('A.RGN')).toEqual(data);
  });

  test('skips a zeroed FAT slot between entries', async () => {
    const raw = buildImg({ 'A.TRE': filled(10, 'a'), 'B.TRE': filled(10, 'b'), 'C.TRE': filled(10, 'c') });
    raw.fill(0, 0x600, 0x800);
    const img = await open(raw);
    expect(await img.read('A.TRE')).toEqual(filled(10, 'a'));
    expect(await img.read('C.TRE')).toEqual(filled(10, 'c'));
    expect(img.has('B.TRE')).toBe(false);
  });
});

describe.skipIf(!hasRealData)('ImgContainer on real data', () => {
  test('Detailed IMG', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    expect(img.tileIds()).toEqual(['14057401', '14057402', '14057403', '14057405', '14057406']);
    expect(img.size('14057403.RGN')).toBe(17504055);
    const typ = await img.read(img.firstOfType('TYP')!, 0, 12);
    expect(String.fromCharCode(...typ.subarray(2, 12))).toBe('GARMIN TYP');
    await src.close();
  });
});
