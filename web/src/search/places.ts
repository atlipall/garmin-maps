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
      const xs = obj.coords.map((c) => c[0]);
      const ys = obj.coords.map((c) => c[1]);
      lon = mapUnitsToDeg((Math.min(...xs) + Math.max(...xs)) / 2);
      lat = mapUnitsToDeg((Math.min(...ys) + Math.max(...ys)) / 2);
    }
    const key = `${normalize(name)}|${obj.kind}|${Math.round(lon * 20)}|${Math.round(lat * 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, lon, lat, kind: obj.kind, type: obj.type });
  }, { bits });
  return out;
}
