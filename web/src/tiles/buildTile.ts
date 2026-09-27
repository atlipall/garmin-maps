import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { clipPolygon, clipPolyline } from 'lineclip';
import { decodeSubdivision, type RawObject } from '../img/rgn';
import { shiftOf, subdivisionBounds, type Subdivision } from '../img/tre';
import { objectName, type GarminMap } from '../map/garminMap';
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

export class SubdivisionCache {
  private readonly map = new Map<string, RawObject[]>();
  constructor(private readonly max: number) {}

  get(key: string): RawObject[] | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: RawObject[]): void {
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
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

export async function buildTile(
  map: GarminMap, cache: SubdivisionCache, z: number, x: number, y: number,
): Promise<{ data: Uint8Array; badSections: number; features: number }> {
  const layers: Record<'points' | 'lines' | 'polygons', TileFeature[]> = { points: [], lines: [], polygons: [] };
  let badSections = 0;
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

    for (const tile of map.tiles) {
      for (const sd of tile.byLevel.get(bits) ?? []) {
        if (!intersects(paddedSubdivisionBounds(sd), query)) continue;
        const key = `${tile.id}:${sd.index}`;
        let objs = cache.get(key);
        if (!objs) {
          const stats = { sections: 0, badSections: 0 };
          objs = decodeSubdivision(await map.readSubdivision(tile, sd), sd, stats);
          badSections += stats.badSections;
          cache.set(key, objs);
        }
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
          if (name) feature.tags.name = name;
          layers[LAYER[obj.kind]].push(feature);
        }
      }
    }
  }
  const data = fromGeojsonVt(
    { points: { features: layers.points }, lines: { features: layers.lines }, polygons: { features: layers.polygons } } as never,
    { version: 2, extent: EXTENT },
  );
  return { data, badSections, features: layers.points.length + layers.lines.length + layers.polygons.length };
}
