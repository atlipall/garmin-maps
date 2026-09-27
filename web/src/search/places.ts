import { mapUnitsToDeg } from '../img/bytes';
import type { Kind } from '../img/rgn';
import { decodeAll } from '../map/decodeAll';
import { objectName, type GarminMap } from '../map/garminMap';
import { CONTOUR_LINE_TYPES, isNumber } from '../map/zoom';
import { normalize } from './normalize';

export interface Place {
  name: string;
  lon: number;
  lat: number;
  kind: Kind;
  type: number;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Midpoint of a coordinate array's bounding box. Loops rather than spreading into `Math.min`/
 * `Math.max` — a spread of more than ~130k arguments overflows V8's call stack (fewer on some
 * mobile engines), which would otherwise reject the whole `collectPlaces` call on a large polygon
 * or line.
 */
export function bboxCenter(coords: Array<[number, number]>): [number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Named objects of the most detailed level, deduplicated by name within ~0.05°. */
export async function collectPlaces(map: GarminMap): Promise<Place[]> {
  const bits = Math.max(...map.bands.keys());
  const seen = new Set<string>();
  const out: Place[] = [];
  await decodeAll(map, (tile, _sd, obj) => {
    if (obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type)) return;
    const name = objectName(tile, obj);
    if (!name || isNumber(name)) return;
    let lon: number;
    let lat: number;
    if (obj.kind === 'point') {
      [lon, lat] = obj.coords[0].map(mapUnitsToDeg);
    } else {
      const [cx, cy] = bboxCenter(obj.coords);
      lon = mapUnitsToDeg(cx);
      lat = mapUnitsToDeg(cy);
    }
    lon = round5(lon);
    lat = round5(lat);
    const key = `${normalize(name)}|${obj.kind}|${Math.round(lon * 20)}|${Math.round(lat * 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, lon, lat, kind: obj.kind, type: obj.type });
  }, { bits });
  return out;
}
