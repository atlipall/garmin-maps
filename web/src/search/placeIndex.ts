import { normalize } from './normalize';
import type { Place } from './places';

const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;

interface Entry {
  place: Place;
  norm: string;
  words: string[];
}

/** Entries are sorted once by (kind rank, normalized-name length, name); a search then scans in
 *  that order, bucketing hits by match score, so within a score the hits come out already ranked
 *  and at most `limit` per score are kept. The result equals sorting every hit by (score, kind
 *  rank, length, name) — including ties, since both sorts are stable over the input order — but
 *  costs no per-query sort and stops early once `limit` exact-prefix hits are found. */
export class PlaceIndex {
  private readonly entries: Entry[];

  constructor(places: Place[]) {
    this.entries = places
      .map((place) => {
        const norm = normalize(place.name);
        return { place, norm, words: norm.split(' ') };
      })
      .sort((a, b) => KIND_RANK[a.place.kind] - KIND_RANK[b.place.kind] || a.norm.length - b.norm.length || a.place.name.localeCompare(b.place.name));
  }

  search(query: string, limit = 20): Place[] {
    const q = normalize(query);
    if (!q || limit <= 0) return [];
    const buckets: Place[][] = [[], [], []];
    for (const e of this.entries) {
      let score: number;
      if (e.norm.startsWith(q)) score = 0;
      else if (e.words.some((w) => w.startsWith(q))) score = 1;
      else if (q.length >= 3 && e.norm.includes(q)) score = 2;
      else continue;
      const b = buckets[score];
      if (b.length < limit) b.push(e.place);
      if (score === 0 && b.length >= limit) break; // nothing can outrank a full set of prefix hits
    }
    return buckets.flat().slice(0, limit);
  }
}
