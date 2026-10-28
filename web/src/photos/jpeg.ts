/**
 * JPEG metadata segments: taking them out of one JPEG and putting them into another, so the smaller
 * copy the app keeps of a photo carries everything the original said about itself (EXIF with the
 * time, place and camera, XMP, the colour profile, IPTC, comments).
 *
 * A JPEG is SOI (FFD8), then segments (FFxx + a 2-byte length that counts itself), then the
 * compressed picture from SOS (FFDA) on. Metadata sits in the APPn segments (FFE0-FFEF) and COM
 * (FFFE) before SOS.
 */

export interface Segment {
  /** The marker's second byte: 0xE1 for APP1, 0xFE for COM… */
  marker: number;
  /** The segment's payload (after its length bytes). */
  data: Uint8Array;
}

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP15 = 0xef;
const COM = 0xfe;

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const EXIF_ID = ascii('Exif\0\0');
export const XMP_ID = ascii('http://ns.adobe.com/xap/1.0/\0');
export const ICC_ID = ascii('ICC_PROFILE\0');
const MPF_ID = ascii('MPF\0');
const JFIF_ID = ascii('JFIF\0');

export const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === SOI;

/** The segments before the picture data (SOS), in order. Throws on a file that isn't a JPEG. */
export const readSegments = (bytes: Uint8Array): Segment[] => scan(bytes).segments;

/** The segments, and where SOS (the picture data) starts. */
function scan(bytes: Uint8Array): { segments: Segment[]; sos: number } {
  if (!isJpeg(bytes)) throw new Error('Not a JPEG.');
  const out: Segment[] = [];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('Damaged JPEG.');
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === SOS) return { segments: out, sos: i };
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) throw new Error('Damaged JPEG.');
    out.push({ marker, data: bytes.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  throw new Error('Damaged JPEG.');
}

/** The segments that describe the photo: every APPn and comment except the ones about the file's
 *  own layout (JFIF's header, which the new JPEG has its own of, and MPF, which points at the
 *  HDR and depth pictures stored after the main one, which a copy doesn't have). */
export function metadataSegments(bytes: Uint8Array): Segment[] {
  return readSegments(bytes).filter((s) => {
    if (s.marker === COM) return true;
    if (s.marker < APP0 || s.marker > APP15) return false;
    if (s.marker === APP0 && startsWith(s.data, JFIF_ID)) return false;
    if (s.marker === APP2 && startsWith(s.data, MPF_ID)) return false;
    return true;
  });
}

/** The TIFF block of the EXIF segment (what follows "Exif\0\0"), if there is one. */
export function exifOf(segments: Segment[]): Uint8Array | null {
  const s = segments.find((x) => x.marker === APP1 && startsWith(x.data, EXIF_ID));
  return s ? s.data.subarray(EXIF_ID.length) : null;
}

/** The XMP packet (text), if there is one. */
export function xmpOf(segments: Segment[]): string | null {
  const s = segments.find((x) => x.marker === APP1 && startsWith(x.data, XMP_ID));
  return s ? new TextDecoder().decode(s.data.subarray(XMP_ID.length)) : null;
}

/** The ICC colour profile, put back together from its chunks, if there is one. */
export function iccOf(segments: Segment[]): Uint8Array | null {
  const chunks = segments.filter((x) => x.marker === APP2 && startsWith(x.data, ICC_ID)).map((x) => ({ n: x.data[ICC_ID.length], data: x.data.subarray(ICC_ID.length + 2) }));
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.n - b.n);
  return concat(chunks.map((c) => c.data));
}

export const exifSegment = (tiff: Uint8Array): Segment => ({ marker: APP1, data: concat([EXIF_ID, tiff]) });
export const xmpSegment = (xmp: string): Segment => ({ marker: APP1, data: concat([XMP_ID, new TextEncoder().encode(xmp)]) });

/** An ICC profile as APP2 segments (a segment holds at most 65519 bytes of it). */
export function iccSegments(icc: Uint8Array): Segment[] {
  const max = 65535 - 2 - ICC_ID.length - 2;
  const n = Math.ceil(icc.length / max);
  return Array.from({ length: n }, (_, i) => ({ marker: APP2, data: concat([ICC_ID, Uint8Array.of(i + 1, n), icc.subarray(i * max, (i + 1) * max)]) }));
}

/** `segments` in place of the JPEG's own APPn and comment segments (put first, EXIF leading, as
 *  the EXIF standard asks); the picture data is left as it is. */
export function withSegments(jpeg: Uint8Array, segments: Segment[]): Uint8Array {
  const { segments: own, sos } = scan(jpeg);
  const kept = own.filter((s) => s.marker !== COM && (s.marker < APP0 || s.marker > APP15));
  const exifFirst = [...segments].sort((a, b) => rank(a) - rank(b));
  const parts: Uint8Array[] = [Uint8Array.of(0xff, SOI)];
  for (const s of [...exifFirst, ...kept]) {
    if (s.data.length + 2 > 0xffff) throw new Error('A metadata block is too large for a JPEG.');
    const len = s.data.length + 2;
    parts.push(Uint8Array.of(0xff, s.marker, len >> 8, len & 0xff), s.data);
  }
  parts.push(jpeg.subarray(sos));
  return concat(parts);
}

const rank = (s: Segment) => (s.marker === APP1 && startsWith(s.data, EXIF_ID) ? 0 : 1);

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
