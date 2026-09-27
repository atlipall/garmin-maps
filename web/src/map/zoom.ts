export const ZOOM_OFFSET = 11;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 14;
export const CONTOUR_LINE_TYPES = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);

/** Python's round(): halves go to the nearest even integer. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** Map level resolution (bits) to a [minzoom, maxzoom] band in MapLibre zoom. */
export function zoomBands(bits: number[]): Map<number, [number, number]> {
  const levels = [...new Set(bits)].sort((a, b) => a - b);
  const starts = [MIN_ZOOM, ...levels.slice(1).map((b) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b - ZOOM_OFFSET)))];
  const bands = new Map<number, [number, number]>();
  levels.forEach((b, i) => {
    const end = i + 1 < levels.length ? starts[i + 1] - 1 : MAX_ZOOM;
    if (end >= starts[i]) bands.set(b, [starts[i], end]);
  });
  return bands;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function isNumber(s: string): boolean {
  return NUMBER.test(s.trim());
}

export function contourLabel(name: string): string {
  return isNumber(name) ? String(pyRound(parseFloat(name) * 0.3048)) : name;
}
