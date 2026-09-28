import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { clipPolygon, clipPolyline } from 'lineclip';
import { decodeSubdivision, type RawObject } from '../img/rgn';
import { shiftOf, subdivisionBounds, type Subdivision } from '../img/tre';
import { objectName, type GarminMap, type MapTile } from '../map/garminMap';
import { CONTOUR_LINE_TYPES } from '../map/zoom';
import { tileBounds } from './tileMath';

export const EXTENT = 4096;
export const BUFFER = 64;
/**
 * Margin applied to each subdivision's declared bounds before the intersection pre-filter, as a
 * fraction of that subdivision's half-extent (per axis). The declared boxes in the real Iceland
 * "Detailed" map exactly bound their objects (measured max overshoot fraction: 0 at every level
 * bits — see test/tiles.test.ts), so this is headroom rather than a correction for observed
 * overshoot. Never goes below 0.
 */
export const SD_MARGIN = 0.05;
const UNITS_PER_DEG = 16777216 / 360;
const LAYER = { point: 'points', line: 'lines', polygon: 'polygons' } as const;

type Pt = [number, number];
type BBox = [number, number, number, number];
interface TileFeature {
  type: 1 | 2 | 3;
  geometry: Pt[] | Pt[][];
  tags: Record<string, string | number>;
}

interface CacheEntry {
  promise: Promise<RawObject[]>;
  /** Total `coords.length` across the resolved objects, or `null` while still in flight (an
   *  in-flight entry is never evicted: its size isn't known yet, and other callers may be
   *  awaiting the same promise). */
  points: number | null;
}

/**
 * Caches decoded subdivisions by key, bounded by total point count rather than entry count (a
 * fixed entry cap let level-24 data - many points per subdivision - use unbounded memory: see the
 * Plan 1 review). Concurrent `get()` calls for the same key before the load settles share one
 * in-flight promise, so two `buildTile` calls in the same worker that both need a subdivision
 * decode it once. A rejected load is not cached, so the next `get()` retries it.
 */
export class SubdivisionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalPoints = 0;

  constructor(private readonly maxPoints: number = 500_000) {}

  get(key: string, load: () => Promise<RawObject[]>): Promise<RawObject[]> {
    const existing = this.entries.get(key);
    if (existing) {
      // Touch: move to the end so eviction below stays least-recently-used.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    const entry = { points: null } as CacheEntry;
    entry.promise = load().then(
      (objs) => {
        entry.points = objs.reduce((n, o) => n + o.coords.length, 0);
        this.totalPoints += entry.points;
        this.evict();
        return objs;
      },
      (err) => {
        this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** Drops every cached (and in-flight) entry, e.g. when a worker opens a different file. */
  clear(): void {
    this.entries.clear();
    this.totalPoints = 0;
  }

  private evict(): void {
    for (const [key, e] of this.entries) {
      if (this.totalPoints <= this.maxPoints) break;
      if (e.points === null) continue; // in-flight: unknown size, and may still be awaited elsewhere
      this.entries.delete(key);
      this.totalPoints -= e.points;
    }
  }
}

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** `subdivisionBounds(sd)` padded by `SD_MARGIN` times the subdivision's half-extent, per axis. */
export function paddedSubdivisionBounds(sd: Subdivision): BBox {
  const [w, s, e, n] = subdivisionBounds(sd);
  const k = 2 ** shiftOf(sd);
  const padX = sd.halfWidth * k * SD_MARGIN;
  const padY = sd.halfHeight * k * SD_MARGIN;
  return [w - padX, s - padY, e + padX, n + padY];
}

export function coordsBounds(coords: Array<[number, number]>): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function roundDedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of points) {
    const p: Pt = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

const ringArea = (ring: Pt[]) =>
  Math.abs(ring.reduce((sum, p, i) => sum + (i ? ring[i - 1][0] * p[1] - p[0] * ring[i - 1][1] : 0), 0)) / 2;

/**
 * A point inside a polygon to hang its label on: the area centroid when it lies inside, else the
 * middle of the widest interior span along the horizontal line through the centroid (so a
 * U-shaped lake is labelled on water, not in its bay). Works in any planar units.
 */
export function polygonLabelAnchor(ring: Array<[number, number]>): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  if (a === 0) return ring[0];
  cx /= 3 * a;
  cy /= 3 * a;
  // Crossings of the horizontal line y = cy; consecutive pairs bound the interior spans.
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((p, q) => p - q);
  let best: [number, number] | null = null;
  let width = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k] <= cx && cx <= xs[k + 1]) return [cx, cy];
    if (xs[k + 1] - xs[k] > width) {
      width = xs[k + 1] - xs[k];
      best = [(xs[k] + xs[k + 1]) / 2, cy];
    }
  }
  return best ?? ring[0];
}

/**
 * Garmin stores a river or road as many short pieces with the same name, and MapLibre labels each
 * piece on its own, so one river got several labels close together. Join the pieces of each named
 * line (same type and name) that touch end to end into continuous lines, so labels are spaced
 * along the whole line by `symbol-spacing`. Unnamed lines and contours pass through unchanged
 * (contours keep a label per ring: equal elevations on different hills are different lines).
 */
export function stitchLines(features: TileFeature[]): TileFeature[] {
  const out: TileFeature[] = [];
  const groups = new Map<string, { tags: TileFeature['tags']; parts: Pt[][] }>();
  for (const f of features) {
    const name = f.tags.name;
    if (name === undefined || CONTOUR_LINE_TYPES.has(f.tags.t as number)) {
      out.push(f);
      continue;
    }
    const key = `${f.tags.t}|${name}`;
    const g = groups.get(key) ?? groups.set(key, { tags: f.tags, parts: [] }).get(key)!;
    g.parts.push(...(f.geometry as Pt[][]));
  }
  for (const { tags, parts } of groups.values()) out.push({ type: 2, geometry: joinParts(parts), tags });
  return out;
}

const ptKey = (p: Pt) => `${p[0]},${p[1]}`;

/** Greedily chain polylines that share endpoints (reversing pieces as needed). */
function joinParts(parts: Pt[][]): Pt[][] {
  const byEnd = new Map<string, number[]>();
  parts.forEach((part, i) => {
    for (const p of [part[0], part[part.length - 1]]) {
      const k = ptKey(p);
      (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(i);
    }
  });
  const used = new Array<boolean>(parts.length).fill(false);
  const takeAt = (p: Pt): Pt[] | null => {
    for (const i of byEnd.get(ptKey(p)) ?? []) {
      if (used[i]) continue;
      used[i] = true;
      const part = parts[i];
      return ptKey(part[0]) === ptKey(p) ? part : [...part].reverse();
    }
    return null;
  };
  const chains: Pt[][] = [];
  for (let i = 0; i < parts.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = parts[i];
    for (let next = takeAt(chain[chain.length - 1]); next; next = takeAt(chain[chain.length - 1])) chain = chain.concat(next.slice(1));
    for (let prev = takeAt(chain[0]); prev; prev = takeAt(chain[0])) chain = [...prev].reverse().concat(chain.slice(1));
    chains.push(chain);
  }
  return chains;
}

/**
 * Keep only the label point of the largest polygon carrying each name in a tile (Garmin splits a
 * big lake or area into several polygons; each would otherwise get its own label).
 */
export function dedupeLabels(features: TileFeature[], sizeOf: (f: TileFeature) => number | undefined): void {
  const best = new Map<string, { feature: TileFeature; size: number }>();
  for (const f of features) {
    const name = f.tags.name;
    if (name === undefined || f.type !== 1) continue;
    const size = sizeOf(f) ?? 0;
    const prev = best.get(String(name));
    if (!prev) {
      best.set(String(name), { feature: f, size });
    } else if (size > prev.size) {
      delete prev.feature.tags.name;
      best.set(String(name), { feature: f, size });
    } else {
      delete f.tags.name;
    }
  }
}

export async function buildTile(
  map: GarminMap, cache: SubdivisionCache, z: number, x: number, y: number,
): Promise<{ data: Uint8Array; badSections: number; features: number }> {
  const layers: Record<'points' | 'lines' | 'polygons', TileFeature[]> = { points: [], lines: [], polygons: [] };
  let badSections = 0;
  const labelArea = new Map<TileFeature, number>();
  const bits = map.levelForZoom(z);
  if (bits !== undefined) {
    const [w, s, e, n] = tileBounds(z, x, y);
    const padX = ((e - w) * BUFFER) / EXTENT;
    const padY = ((n - s) * BUFFER) / EXTENT;
    const query: BBox = [(w - padX) * UNITS_PER_DEG, (s - padY) * UNITS_PER_DEG, (e + padX) * UNITS_PER_DEG, (n + padY) * UNITS_PER_DEG];
    const scale = 2 ** z;
    const project = ([mx, my]: [number, number]): Pt => {
      const lat = ((my / UNITS_PER_DEG) * Math.PI) / 180;
      return [
        ((mx / UNITS_PER_DEG + 180) / 360 * scale - x) * EXTENT,
        ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale - y) * EXTENT,
      ];
    };
    const clip: BBox = [-BUFFER, -BUFFER, EXTENT + BUFFER, EXTENT + BUFFER];

    // Collect every subdivision that intersects the tile first, then resolve them all in parallel
    // via the cache: a cache hit (resolved or already in flight from a concurrent buildTile call)
    // resolves immediately/shares that promise, and a miss reads+decodes once. Output is
    // identical either way: `resolved` ends up holding the same objects for the same keys.
    interface Entry { tile: MapTile; sd: Subdivision; key: string }
    const entries: Entry[] = [];
    for (const tile of map.tiles) {
      for (const sd of tile.byLevel.get(bits) ?? []) {
        if (!intersects(paddedSubdivisionBounds(sd), query)) continue;
        entries.push({ tile, sd, key: `${tile.id}:${sd.index}` });
      }
    }
    const resolved = new Map<string, RawObject[]>();
    await Promise.all(entries.map(async (e) => {
      const objs = await cache.get(e.key, async () => {
        const bytes = await map.readSubdivision(e.tile, e.sd);
        const stats = { sections: 0, badSections: 0 };
        const decoded = decodeSubdivision(bytes, e.sd, stats);
        badSections += stats.badSections;
        return decoded;
      });
      resolved.set(e.key, objs);
    }));

    for (const { tile, key } of entries) {
      const objs = resolved.get(key)!;
      for (const obj of objs) {
        if (!intersects(coordsBounds(obj.coords), query)) continue;
        const pts = obj.coords.map(project);
        let feature: TileFeature | null = null;
        if (obj.kind === 'point') {
          const [px, py] = pts[0];
          if (px >= clip[0] && px <= clip[2] && py >= clip[1] && py <= clip[3]) feature = { type: 1, geometry: [[Math.round(px), Math.round(py)]], tags: {} };
        } else if (obj.kind === 'line') {
          const parts = clipPolyline(pts, clip).map(roundDedupe).filter((p) => p.length >= 2);
          if (parts.length) feature = { type: 2, geometry: parts, tags: {} };
        } else {
          const ring = roundDedupe(clipPolygon(pts, clip));
          if (ring.length >= 3) {
            const [f, l] = [ring[0], ring[ring.length - 1]];
            if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
            feature = { type: 3, geometry: [ring], tags: {} };
          }
        }
        if (!feature) continue;
        feature.tags.t = obj.type;
        const name = objectName(tile, obj);
        if (name && obj.kind === 'polygon') {
          // One label per polygon, not one per tile it crosses: anchor it on the whole polygon and
          // emit it only from the tile that holds the anchor.
          const [ax, ay] = project(polygonLabelAnchor(obj.coords));
          if (ax >= 0 && ax < EXTENT && ay >= 0 && ay < EXTENT) {
            const label: TileFeature = { type: 1, geometry: [[Math.round(ax), Math.round(ay)]], tags: { t: obj.type, name } };
            labelArea.set(label, ringArea(pts));
            layers.polygons.push(label);
          }
        } else if (name) {
          feature.tags.name = name;
        }
        layers[LAYER[obj.kind]].push(feature);
      }
    }
  }
  layers.lines = stitchLines(layers.lines);
  dedupeLabels(layers.polygons, (f) => labelArea.get(f));
  const data = fromGeojsonVt(
    { points: { features: layers.points }, lines: { features: layers.lines }, polygons: { features: layers.polygons } } as never,
    { version: 2, extent: EXTENT },
  );
  return { data, badSections, features: layers.points.length + layers.lines.length + layers.polygons.length };
}
