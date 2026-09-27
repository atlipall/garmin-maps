import { normalize } from './normalize';
import type { Place } from './places';

const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;

interface Entry {
  place: Place;
  norm: string;
  words: string[];
}

export class PlaceIndex {
  private readonly entries: Entry[];

  constructor(places: Place[]) {
    this.entries = places.map((place) => {
      const norm = normalize(place.name);
      return { place, norm, words: norm.split(' ') };
    });
  }

  search(query: string, limit = 20): Place[] {
    const q = normalize(query);
    if (!q) return [];
    const hits: Array<[number, number, number, string, Place]> = [];
    for (const e of this.entries) {
      let score: number;
      if (e.norm.startsWith(q)) score = 0;
      else if (e.words.some((w) => w.startsWith(q))) score = 1;
      else if (q.length >= 3 && e.norm.includes(q)) score = 2;
      else continue;
      hits.push([score, KIND_RANK[e.place.kind], e.norm.length, e.place.name, e.place]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]));
    return hits.slice(0, limit).map((h) => h[4]);
  }
}
