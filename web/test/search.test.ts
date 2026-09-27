import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GarminMap } from '../src/map/garminMap';
import { normalize } from '../src/search/normalize';
import { PlaceIndex } from '../src/search/placeIndex';
import { bboxCenter, collectPlaces, type Place } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

describe('normalize', () => {
  test('Icelandic letters and diacritics', () => {
    expect(normalize('Þórsmörk')).toBe('thorsmork');
    expect(normalize('Hvannadalshnúkur')).toBe('hvannadalshnukur');
    expect(normalize('ÆGISÍÐA')).toBe('aegisida');
    expect(normalize('  Fjallabak-syðra ')).toBe('fjallabak sydra');
  });
});

describe('PlaceIndex', () => {
  const idx = new PlaceIndex([
    { name: 'Laugavegur', lon: 0, lat: 0, kind: 'line', type: 0x16 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'point', type: 0x2f06 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'polygon', type: 0x13 },
    { name: 'Hveragerði', lon: 2, lat: 2, kind: 'point', type: 0x0400 },
    { name: 'Efri Laugar', lon: 3, lat: 3, kind: 'point', type: 0x0400 },
  ]);

  test('prefix beats word-prefix beats substring; points first', () => {
    expect(idx.search('lau').map((p) => [p.name, p.kind])).toEqual([
      ['Laugavegur', 'line'],
      ['Efri Laugar', 'point'],
      ['Landmannalaugar', 'point'],
      ['Landmannalaugar', 'polygon'],
    ]);
    expect(idx.search('landm')[0]).toMatchObject({ name: 'Landmannalaugar', kind: 'point' });
    expect(idx.search('hverag')[0].name).toBe('Hveragerði');
    expect(idx.search('')).toEqual([]);
    expect(idx.search('la', 2)).toHaveLength(2);
  });
});

describe('bboxCenter', () => {
  test('does not overflow the call stack on large coordinate arrays', () => {
    const coords: Array<[number, number]> = Array.from({ length: 200_000 }, (_, i) => [i, -i]);
    expect(() => bboxCenter(coords)).not.toThrow();
    expect(bboxCenter(coords)).toEqual([99999.5, -99999.5]);
  });

  test('midpoint of a small bounding box', () => {
    expect(bboxCenter([[0, 0], [10, 4], [2, -6]])).toEqual([5, -1]);
  });
});

describe.skipIf(!hasRealData)('search on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let places: Place[];
  let idx: PlaceIndex;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    places = await collectPlaces(await GarminMap.open(src));
    console.log(`places: ${places.length}`);
    idx = new PlaceIndex(places);
  }, 300_000);
  afterAll(() => src.close());

  test('finds well-known places', () => {
    const lm = idx.search('landmannalaugar')[0];
    expect(Math.abs(lm.lon - -19.06)).toBeLessThan(0.1);
    expect(Math.abs(lm.lat - 63.99)).toBeLessThan(0.1);
    expect(idx.search('thorsmork').some((p) => normalize(p.name) === 'thorsmork')).toBe(true);
    expect(normalize(idx.search('reykjav')[0].name).startsWith('reykjavik')).toBe(true);
  });

  test('coordinates are rounded to 5 decimals', () => {
    const offGrid = (v: number) => Math.abs(v * 1e5 - Math.round(v * 1e5));
    for (const p of places) {
      expect(offGrid(p.lon)).toBeLessThan(1e-6);
      expect(offGrid(p.lat)).toBeLessThan(1e-6);
    }
  });
});
