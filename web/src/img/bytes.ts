export class ImgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImgError';
  }
}

export function u8(b: Uint8Array, o: number): number {
  if (o < 0 || o >= b.length) throw new RangeError(`read past end at offset ${o} (length ${b.length})`);
  return b[o];
}

export function u16(b: Uint8Array, o: number): number {
  return u8(b, o) | (u8(b, o + 1) << 8);
}

export function s16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
}

export function u24(b: Uint8Array, o: number): number {
  return u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16);
}

export function s24(b: Uint8Array, o: number): number {
  const v = u24(b, o);
  return v & 0x800000 ? v - 0x1000000 : v;
}

export function u32(b: Uint8Array, o: number): number {
  return u24(b, o) + u8(b, o + 3) * 0x1000000;
}

export function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

export function mapUnitsToDeg(v: number): number {
  return (v * 360) / 16777216;
}
