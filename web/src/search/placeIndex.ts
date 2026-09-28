import { nearness } from './describe';
import { normalize } from './normalize';
import type { Place } from './places';

const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;
const NEARBY_KM = 25;
/** NEARBY_KM as a squared equirectangular distance in degrees (see `nearness`). */
const NEARBY_DEG2 = (NEARBY_KM / 111.2) ** 2;

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

  constructor(readonly places: Place[]) {
    this.entries = places
      .map((place) => {
        const norm = normalize(place.name);
        return { place, norm, words: norm.split(' ') };
      })
      .sort((a, b) => KIND_RANK[a.place.kind] - KIND_RANK[b.place.kind] || a.norm.length - b.norm.length || a.place.name.localeCompare(b.place.name));
  }

  /** With `near`, hits of equal match score within NEARBY_KM of it come first, nearest first
   *  (every hit is scored then, since the nearest may come anywhere in the static order). */
  search(query: string, limit = 20, near?: [number, number]): Place[] {
    const q = normalize(query);
    if (!q || limit <= 0) return [];
    if (near) {
      const buckets: Place[][] = [[], [], []];
      for (const e of this.entries) {
        const score = this.score(e, q);
        if (score >= 0) buckets[score].push(e.place);
      }
      // Nearby hits (within NEARBY_KM) first, nearest first; the rest keep the static order, so a
      // distant but well-known name is not buried under every minor nearby-ish match.
      const nearby = (p: Place) => nearness(p, near) < NEARBY_DEG2;
      return buckets.flatMap((b) => [
        ...b.filter(nearby).map((p) => [nearness(p, near), p] as const).sort((x, y) => x[0] - y[0]).map(([, p]) => p),
        ...b.filter((p) => !nearby(p)),
      ]).slice(0, limit);
    }
    const buckets: Place[][] = [[], [], []];
    for (const e of this.entries) {
      const score = this.score(e, q);
      if (score < 0) continue;
      const b = buckets[score];
      if (b.length < limit) b.push(e.place);
      if (score === 0 && b.length >= limit) break; // nothing can outrank a full set of prefix hits
    }
    return buckets.flat().slice(0, limit);
  }

  /** 0 = name prefix, 1 = word prefix, 2 = substring (3+ chars), -1 = no match. */
  private score(e: Entry, q: string): number {
    if (e.norm.startsWith(q)) return 0;
    if (e.words.some((w) => w.startsWith(q))) return 1;
    if (q.length >= 3 && e.norm.includes(q)) return 2;
    return -1;
  }
}
