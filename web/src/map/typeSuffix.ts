/**
 * Freizeitkarte (an OpenStreetMap-based Garmin map) writes what a point is after its name, in
 * brackets: "Dettifoss (Waterfall)", "Vínbúðin (Off Licence)", a peak's height as "Hestur (455)",
 * "N.N. (747)" for an unnamed peak and "(yes)" where OSM had no better word. GPSmap.is uses brackets
 * for alternative names ("GILSÁ (TRÖLLADALSÁ)"), so this applies to Freizeitkarte maps only.
 */

/** Freizeitkarte maps, by the name in their IMG header ("Freizeitkarte_ISL (Release 26.09)"). */
export const hasTypeSuffixes = (description: string) => /^Freizeitkarte/i.test(description);

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
