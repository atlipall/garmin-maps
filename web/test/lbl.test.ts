import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { formatLabel, LabelTable } from '../src/img/lbl';
import { decodeSubdivision, type Chunk } from '../src/img/rgn';
import { parseTre } from '../src/img/tre';
import { bytesOf, concat } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const cp1252 = new TextDecoder('windows-1252');

function makeLbl(strings: Uint8Array[], encoding = 9, poi = new Uint8Array(0)): Uint8Array {
  const hlen = 0xac;
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN LBL'), 2);
  const data = concat(new Uint8Array([0]), ...strings.map((s) => concat(s, new Uint8Array([0]))));
  dv.setUint32(0x15, hlen, true);
  dv.setUint32(0x19, data.length, true);
  h[0x1e] = encoding;
  dv.setUint32(0x57, hlen + data.length, true);
  dv.setUint32(0x5b, poi.length, true);
  dv.setUint16(0xaa, 1252, true);
  return concat(h, data, poi);
}

describe('formatLabel', () => {
  test('icelandic codepage', () => expect(formatLabel(new Uint8Array([0x47, 0xf6, 0x6e, 0x67, 0x75, 0x73, 0x6b, 0x61, 0x72, 0xf0]), cp1252)).toBe('Gönguskarð'));
  test('elevation suffix in feet becomes metres', () => expect(formatLabel(concat(bytesOf('HEKLA'), new Uint8Array([0x1f]), bytesOf('4892')), cp1252)).toBe('HEKLA 1491 m'));
  test('elevation followed by another separator', () =>
    expect(formatLabel(concat(bytesOf('A'), new Uint8Array([0x1f]), bytesOf('4892'), new Uint8Array([0x1b]), bytesOf('XYZ')), cp1252)).toBe('A 1491 m XYZ'));
  test('control bytes are dropped', () => expect(formatLabel(new Uint8Array([0x01, 0x41, 0x1b, 0x42]), cp1252)).toBe('A B'));
});

describe('LabelTable', () => {
  test('lookup by offset and POI', () => {
    const table = new LabelTable(makeLbl([bytesOf('Vatn'), bytesOf('Hraun')], 9, new Uint8Array([6, 0, 0])), null);
    expect(table.text(1, 'lbl')).toBe('Vatn');
    expect(table.text(6, 'lbl')).toBe('Hraun');
    expect(table.text(0, 'lbl')).toBeNull();
    expect(table.text(0, 'poi')).toBe('Hraun');
  });

  test('NET label', () => {
    const net = new Uint8Array(0x20 + 3);
    net.set(bytesOf('GARMIN NET'), 2);
    new DataView(net.buffer).setUint32(0x15, 0x20, true);
    net.set([1, 0, 0x80], 0x20);
    expect(new LabelTable(makeLbl([bytesOf('Hringvegur')]), net).text(0, 'net')).toBe('Hringvegur');
  });

  test('all of a road\'s labels: its name and its number (Freizeitkarte gives the number second)', () => {
    const net = new Uint8Array(0x20 + 9);
    net.set(bytesOf('GARMIN NET'), 2);
    new DataView(net.buffer).setUint32(0x15, 0x20, true);
    // Road 0: labels at offsets 1 and 15 (the last flagged with bit 23); road 6: one label.
    net.set([1, 0, 0, 15, 0, 0x80, 15, 0, 0x80], 0x20);
    const table = new LabelTable(makeLbl([bytesOf('Landmannaleid'), bytesOf('F208')]), net);
    expect(table.roadTexts(0)).toEqual(['Landmannaleid', 'F208']);
    expect(table.text(0, 'net')).toBe('Landmannaleid');
    expect(table.roadTexts(6)).toEqual(['F208']);
    expect(new LabelTable(makeLbl([bytesOf('X')]), null).roadTexts(0)).toEqual([]);
  });

  test('unsupported encoding', () => expect(() => new LabelTable(makeLbl([bytesOf('X')], 6), null)).toThrow(/encoding 6/));
});

describe.skipIf(!hasRealData)('labels on real data', () => {
  test('names from tile 14057403', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgn = await img.read('14057403.RGN');
    const t = parseTre(await img.read('14057403.TRE'), rgn.subarray(0, 0x7d));
    const table = new LabelTable(await img.read('14057403.LBL'), await img.read('14057403.NET'));
    const c: Chunk = { bytes: rgn, base: 0 };
    const names = new Set<string>();
    for (const sd of t.subdivisions.slice(938, 1400)) {
      for (const o of decodeSubdivision({ main: c, ext: [c, c, c] }, sd, { sections: 0, badSections: 0 })) {
        const n = table.text(o.label, o.labelSrc);
        if (n) names.add(n);
      }
    }
    expect(names.has('Gönguskarð')).toBe(true);
    expect(names.has('Drífandi')).toBe(true);
    await src.close();
  }, 120_000);
});
