import { cumulative, metres } from './maneuvers';
import type { LonLat, RoadSeg } from './plan';

/** Where you are on a route. */
export interface Where {
  /** Metres from the start to the nearest point of the route. */
  along: number;
  /** Metres from you to that point. */
  off: number;
  /** The route point the nearest stretch starts at. */
  index: number;
}

/**
 * Follows a position along a route: the nearest point of the route (looked for near the last one
 * first, so a road that doubles back doesn't make you jump ahead), the distance and driving time
 * left. The time comes from the road stretches' times where the route has them, else in proportion
 * to the distance.
 */
export class Progress {
  readonly cum: number[];
  readonly total: number;
  /** Seconds from the start to each route point. */
  private readonly time: number[];
  private last = 0;

  constructor(readonly coords: LonLat[], segs: RoadSeg[] | undefined, readonly seconds: number) {
    this.cum = cumulative(coords);
    this.total = this.cum[this.cum.length - 1];
    this.time = new Array(coords.length).fill(0);
    if (segs?.length) {
      for (let s = 0; s < segs.length; s++) {
        const a = segs[s].start;
        const b = s + 1 < segs.length ? segs[s + 1].start : coords.length - 1;
        const len = this.cum[b] - this.cum[a];
        for (let i = a + 1; i <= b; i++) this.time[i] = this.time[a] + (len ? segs[s].seconds * ((this.cum[i] - this.cum[a]) / len) : 0);
      }
    } else {
      for (let i = 1; i < coords.length; i++) this.time[i] = this.total ? seconds * (this.cum[i] / this.total) : 0;
    }
  }

  /** The nearest point of the route to `p`. */
  locate(p: LonLat): Where {
    const near = this.nearest(p, Math.max(0, this.last - 20), Math.min(this.coords.length - 1, this.last + 400));
    const best = near.off > 100 ? this.nearest(p, 0, this.coords.length - 1) : near;
    this.last = best.index;
    return best;
  }

  /** Metres and driving seconds from `along` to the end. */
  left(along: number): { metres: number; seconds: number } {
    let i = 0;
    while (i + 1 < this.cum.length && this.cum[i + 1] <= along) i++;
    const j = Math.min(i + 1, this.cum.length - 1);
    const span = this.cum[j] - this.cum[i];
    const t = this.time[i] + (span ? (this.time[j] - this.time[i]) * ((along - this.cum[i]) / span) : 0);
    return { metres: Math.max(0, this.total - along), seconds: Math.max(0, this.time[this.time.length - 1] - t) };
  }

  private nearest(p: LonLat, from: number, to: number): Where {
    const k = Math.cos(p[1] * (Math.PI / 180));
    let best: Where = { along: 0, off: Infinity, index: 0 };
    for (let i = from; i < to; i++) {
      const [ax, ay] = [(this.coords[i][0] - p[0]) * k, this.coords[i][1] - p[1]];
      const [bx, by] = [(this.coords[i + 1][0] - p[0]) * k, this.coords[i + 1][1] - p[1]];
      const [dx, dy] = [bx - ax, by - ay];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const q: LonLat = [this.coords[i][0] + (this.coords[i + 1][0] - this.coords[i][0]) * t, this.coords[i][1] + (this.coords[i + 1][1] - this.coords[i][1]) * t];
      const off = metres(p, q);
      if (off < best.off) best = { along: this.cum[i] + metres(this.coords[i], q), off, index: i };
    }
    if (from === to) best = { along: this.cum[from], off: metres(p, this.coords[from]), index: from };
    return best;
  }
}
