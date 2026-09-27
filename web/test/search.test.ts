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

describe('PlaceIndex matches a naive full sort', () => {
  const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;
  // The pre-optimization implementation: score every entry, sort all hits, slice.
  function naive(places: Place[], query: string, limit = 20): Place[] {
    const q = normalize(query);
    if (!q) return [];
    const hits: Array<[number, number, number, string, Place]> = [];
    for (const place of places) {
      const norm = normalize(place.name);
      let score: number;
      if (norm.startsWith(q)) score = 0;
      else if (norm.split(' ').some((w) => w.startsWith(q))) score = 1;
      else if (q.length >= 3 && norm.includes(q)) score = 2;
      else continue;
      hits.push([score, KIND_RANK[place.kind], norm.length, place.name, place]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]));
    return hits.slice(0, limit).map((h) => h[4]);
  }

  // Deterministic pseudo-random names from a small syllable set, so many names share prefixes,
  // word prefixes and substrings, with duplicates (same name and kind at different coordinates).
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const syll = ['lau', 'gar', 'hvera', 'fjall', 'dalur', 'á', 'þór', 'mörk', 'vík', 'reykja', 'foss', 'nes', 'Lau', 'Ey'];
  const word = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => syll[Math.floor(rand() * syll.length)]).join('');
  const kinds = ['point', 'line', 'polygon'] as const;
  const places: Place[] = Array.from({ length: 5000 }, (_, i) => ({
    name: Array.from({ length: 1 + Math.floor(rand() * 3) }, word).join(rand() < 0.2 ? '-' : ' '),
    lon: i,
    lat: -i,
    kind: kinds[Math.floor(rand() * 3)],
    type: i,
  }));
  const idx = new PlaceIndex(places);

  test.each(['lau', 'la', 'gar', 'hveragerdi', 'thor', 'fjalld', 'ik', 'vik', 'foss nes', 'ey', 'dalu', 'zzz', 'a', 'mork'])('query %s', (q) => {
    for (const limit of [1, 5, 20, 100, 10_000]) {
      expect(idx.search(q, limit)).toEqual(naive(places, q, limit));
    }
    expect(idx.search(q)).toEqual(naive(places, q));
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
