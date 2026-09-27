import { pyRound } from '../map/zoom';

export const HGT_SIZE = 1201;
export const HGT_STEP = 1200;
export const HGT_BYTES = HGT_SIZE * HGT_SIZE * 2;

export function parseHgtName(name: string): { south: number; west: number } | null {
  const base = name.split('/').pop() ?? name;
  const m = /^([ns])(\d{2})([ew])(\d{3})\.hgt$/i.exec(base);
  if (!m) return null;
  return {
    south: (m[1].toLowerCase() === 'n' ? 1 : -1) * Number(m[2]),
    west: (m[3].toLowerCase() === 'e' ? 1 : -1) * Number(m[4]),
  };
}

/** Big-endian int16 samples; voids (-32768) and negative heights become 0, as in imgconv/hillshade.py. */
export function decodeHgt(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = ((bytes[2 * i] << 8) | bytes[2 * i + 1]) << 16 >> 16;
    out[i] = v < 0 ? 0 : v;
  }
  return out;
}

export function encodeTerrainRgb(h: number, out: Uint8ClampedArray, i: number): void {
  const v = pyRound((Math.max(h, 0) + 10000) * 10);
  out[i] = Math.floor(v / 65536) % 256;
  out[i + 1] = Math.floor(v / 256) % 256;
  out[i + 2] = v % 256;
  out[i + 3] = 255;
}

export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}
