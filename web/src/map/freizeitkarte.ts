/**
 * Freizeitkarte (freizeitkarte-osm.de), a free OpenStreetMap-based Garmin map, writes what a point is after its name, in
 * brackets: "Dettifoss (Waterfall)", "Vínbúðin (Off Licence)", a peak's height as "Hestur (455)",
 * "N.N. (747)" for an unnamed peak and "(yes)" where OSM had no better word. GPSmap.is uses brackets
 * for alternative names ("GILSÁ (TRÖLLADALSÁ)"), so ./conventions applies this to Freizeitkarte only.
 */

/** The credit its licence asks for: the map data (ODbL), the map's makers, and the contour lines'
 *  sources (CC BY 4.0; the USGS data is public domain). */
export const FREIZEITKARTE_CREDIT =
  'Map: <a href="https://www.freizeitkarte-osm.de/garmin/en/" target="_blank" rel="noopener">© FZK project</a>, data ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>; ' +
  'contours: Sonny\'s LiDAR DTM, JAXA AW3D30 (CC BY 4.0), USGS';

const UNNAMED = 'N.N.';

/** A point's name without the suffix, and the suffix as a type ("Waterfall") when it is one. A
 *  height becomes part of the name, as GPSmap.is labels peaks ("Hestur 455 m"). */
export function splitTypeSuffix(label: string): { name: string | null; what?: string } {
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(label);
  if (!m) return { name: label === UNNAMED ? null : label };
  const base = m[1] === UNNAMED ? '' : m[1];
  const suffix = m[2].trim();
  if (/^\d+$/.test(suffix)) return { name: base ? `${base} ${suffix} m` : `${suffix} m` };
  if (suffix === 'yes') return { name: base || null };
  return { name: base || suffix, what: suffix[0].toUpperCase() + suffix.slice(1).toLowerCase() };
}
