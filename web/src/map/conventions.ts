import { FREIZEITKARTE_CREDIT, splitTypeSuffix } from './freizeitkarte';

/**
 * How a map writes what the format leaves open, chosen once when the map is opened (by the name in
 * its IMG header). Everything else treats every map alike and just uses these.
 */
export interface MapConventions {
  /** A point's name and what it is, from its label as the map writes it. */
  pointLabel(label: string): { name: string | null; what?: string };
  /** The credit the map's licence asks for (HTML), or null. */
  credit: string | null;
}

const PLAIN: MapConventions = { pointLabel: (label) => ({ name: label }), credit: null };

/** Freizeitkarte (free, OpenStreetMap-based): "Dettifoss (Waterfall)" labels, and a credit. */
const FREIZEITKARTE: MapConventions = { pointLabel: splitTypeSuffix, credit: FREIZEITKARTE_CREDIT };

export function conventionsFor(description: string): MapConventions {
  return /^Freizeitkarte/i.test(description) ? FREIZEITKARTE : PLAIN;
}
