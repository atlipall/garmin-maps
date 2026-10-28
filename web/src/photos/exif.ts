/**
 * Reading what a photo's EXIF says (where and when it was taken, the camera), and the two changes a
 * smaller copy needs: its orientation (the copy's pixels are already turned upright) and its size.
 * Everything else in the block is kept byte for byte, so offsets inside it (maker notes, the
 * thumbnail) stay right.
 *
 * EXIF is a TIFF block: a byte-order mark (II little-endian, MM big-endian), 42, the offset of IFD0;
 * an IFD is a count, 12-byte entries (tag, type, count, value or offset), the next IFD's offset.
 */

export interface ExifInfo {
  lat: number | null;
  lon: number | null;
  /** Metres above sea level. */
  alt: number | null;
  /** When it was taken, as the camera's clock showed it: "2026-08-14T15:42:10" (no time zone). */
  taken: string | null;
  /** The time zone it was taken in, when the camera wrote it ("+00:00"). */
  offset: string | null;
  make: string | null;
  model: string | null;
  orientation: number | null;
  /** 35 mm-equivalent focal length (mm). */
  focal35: number | null;
  fNumber: number | null;
  /** Seconds. */
  exposure: number | null;
}

const IFD0 = { make: 0x010f, model: 0x0110, orientation: 0x0112, exif: 0x8769, gps: 0x8825 };
const EXIF = { exposure: 0x829a, fNumber: 0x829d, taken: 0x9003, offset: 0x9011, width: 0xa002, height: 0xa003, focal35: 0xa405 };
const GPS = { latRef: 1, lat: 2, lonRef: 3, lon: 4, altRef: 5, alt: 6 };
const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Entry {
  type: number;
  count: number;
  /** Where the entry's value is: in the entry itself when it fits in 4 bytes, else at its offset. */
  at: number;
}

class Tiff {
  readonly view: DataView;
  readonly le: boolean;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bom = this.view.getUint16(0);
    if (bom !== 0x4949 && bom !== 0x4d4d) throw new Error('Not an EXIF block.');
    this.le = bom === 0x4949;
    if (this.u16(2) !== 42) throw new Error('Not an EXIF block.');
  }
  u16 = (o: number) => this.view.getUint16(o, this.le);
  u32 = (o: number) => this.view.getUint32(o, this.le);
  ifd(offset: number): Map<number, Entry> {
    const out = new Map<number, Entry>();
    if (offset < 8 || offset + 2 > this.bytes.length) return out;
    const n = this.u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > this.bytes.length) break;
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (SIZES[type] ?? 1) * count;
      const at = size > 4 ? this.u32(e + 8) : e + 8;
      if (at + size > this.bytes.length) continue; // points outside the block: ignore it
      out.set(this.u16(e), { type, count, at });
    }
    return out;
  }
  text(e: Entry | undefined): string | null {
    if (!e || e.type !== 2) return null;
    let s = '';
    for (let i = 0; i < e.count; i++) {
      const c = this.bytes[e.at + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    s = s.trim();
    return s || null;
  }
  num(e: Entry | undefined, i = 0): number | null {
    if (!e || i >= e.count) return null;
    switch (e.type) {
      case 3: return this.u16(e.at + i * 2);
      case 4: return this.u32(e.at + i * 4);
      case 5: {
        const d = this.u32(e.at + i * 8 + 4);
        return d ? this.u32(e.at + i * 8) / d : null;
      }
      case 10: {
        const d = this.view.getInt32(e.at + i * 8 + 4, this.le);
        return d ? this.view.getInt32(e.at + i * 8, this.le) / d : null;
      }
      case 1: case 7: return this.bytes[e.at + i];
      default: return null;
    }
  }
}

/** What the EXIF block says; fields it doesn't have (or has damaged) are null. */
export function readExif(tiffBytes: Uint8Array): ExifInfo {
  const t = new Tiff(tiffBytes);
  const ifd0 = t.ifd(t.u32(4));
  const exif = t.ifd(t.num(ifd0.get(IFD0.exif)) ?? 0);
  const gps = t.ifd(t.num(ifd0.get(IFD0.gps)) ?? 0);
  const dms = (e: Entry | undefined) => {
    const [d, m, s] = [t.num(e, 0), t.num(e, 1), t.num(e, 2)];
    return d === null ? null : d + (m ?? 0) / 60 + (s ?? 0) / 3600;
  };
  let lat = dms(gps.get(GPS.lat));
  let lon = dms(gps.get(GPS.lon));
  if (lat !== null && t.text(gps.get(GPS.latRef)) === 'S') lat = -lat;
  if (lon !== null && t.text(gps.get(GPS.lonRef)) === 'W') lon = -lon;
  // 0,0 is what some apps write when they had no position.
  const valid = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  let alt = t.num(gps.get(GPS.alt));
  if (alt !== null && t.num(gps.get(GPS.altRef)) === 1) alt = -alt;
  const raw = t.text(exif.get(EXIF.taken));
  const m = raw && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
  return {
    lat: valid ? lat : null,
    lon: valid ? lon : null,
    alt: valid ? alt : null,
    taken: m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null,
    offset: t.text(exif.get(EXIF.offset)),
    make: t.text(ifd0.get(IFD0.make)),
    model: t.text(ifd0.get(IFD0.model)),
    orientation: t.num(ifd0.get(IFD0.orientation)),
    focal35: t.num(exif.get(EXIF.focal35)),
    fNumber: t.num(exif.get(EXIF.fNumber)),
    exposure: t.num(exif.get(EXIF.exposure)),
  };
}

/** A copy of the EXIF block for a copy of the photo `width`×`height` px, drawn upright: the
 *  orientation says "as stored" and the size fields say the new size. Nothing else changes. */
export function exifForCopy(tiffBytes: Uint8Array, width: number, height: number): Uint8Array {
  const out = tiffBytes.slice();
  const t = new Tiff(out);
  const set = (e: Entry | undefined, v: number) => {
    if (!e || e.count !== 1) return;
    if (e.type === 3 && v <= 0xffff) t.view.setUint16(e.at, v, t.le);
    else if (e.type === 4) t.view.setUint32(e.at, v, t.le);
  };
  const ifd0 = t.ifd(t.u32(4));
  set(ifd0.get(IFD0.orientation), 1);
  const exif = t.ifd(t.num(ifd0.get(IFD0.exif)) ?? 0);
  set(exif.get(EXIF.width), width);
  set(exif.get(EXIF.height), height);
  return out;
}

/** The camera line under a photo: "iPhone 13 · 26 mm · f/1.6 · 1/1200 s" (what's known of it). */
export function cameraText(x: Pick<ExifInfo, 'make' | 'model' | 'focal35' | 'fNumber' | 'exposure'>): string {
  // "iPhone 13", not "Apple iPhone 13"; "Canon EOS R6" as Canon writes it; a model that doesn't name
  // its maker gets it ("FUJIFILM X-T4").
  const named = (m: string, k: string) => /^apple/i.test(k) || m.toLowerCase().includes(k.toLowerCase().split(' ')[0]);
  const model = x.model && x.make && !named(x.model, x.make) ? `${x.make} ${x.model}` : x.model ?? x.make;
  const exposure = x.exposure ? (x.exposure >= 1 ? `${+x.exposure.toFixed(1)} s` : `1/${Math.round(1 / x.exposure)} s`) : null;
  return [model, x.focal35 ? `${Math.round(x.focal35)} mm` : null, x.fNumber ? `f/${+x.fNumber.toFixed(1)}` : null, exposure].filter(Boolean).join(' · ');
}
