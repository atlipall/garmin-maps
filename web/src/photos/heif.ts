/**
 * The metadata of a HEIC photo (what an iPhone stores, and what a Mac or the Files picker can hand
 * over as it is): its EXIF, XMP and colour profile, so the JPEG copy can carry them.
 *
 * HEIF is ISO boxes (size, type, contents). The `meta` box lists items (`iinf`), where each item's
 * bytes are (`iloc`), and properties (`iprp`: `ipco` holds them, `ipma` says which item has which).
 * EXIF is an item of type `Exif`, XMP a `mime` item of type application/rdf+xml, the colour profile
 * a `colr` property of the primary item (`pitm`).
 */

export interface HeifMetadata {
  /** The EXIF TIFF block. */
  exif: Uint8Array | null;
  xmp: string | null;
  icc: Uint8Array | null;
}

interface Box {
  type: string;
  /** Where the contents start and end (after the size and type). */
  start: number;
  end: number;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

export const isHeif = (b: Uint8Array) => b.length > 12 && fourcc(b, 4) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(fourcc(b, 8));

function boxes(b: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let i = start;
  while (i + 8 <= end) {
    let size = view.getUint32(i);
    const type = fourcc(b, i + 4);
    let head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(i + 8));
      head = 16;
    } else if (size === 0) size = end - i;
    if (size < head || i + size > end) break;
    out.push({ type, start: i + head, end: i + size });
    i += size;
  }
  return out;
}

export function heifMetadata(b: Uint8Array): HeifMetadata {
  const none: HeifMetadata = { exif: null, xmp: null, icc: null };
  if (!isHeif(b)) return none;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const meta = boxes(b, view, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return none;
  // `meta` is a full box: version and flags first.
  const kids = boxes(b, view, meta.start + 4, meta.end);
  const kid = (t: string) => kids.find((x) => x.type === t);

  const pitm = kid('pitm');
  const primary = pitm ? (b[pitm.start] === 0 ? view.getUint16(pitm.start + 4) : view.getUint32(pitm.start + 4)) : -1;

  // Items: id → type (and content type for mime items).
  const items = new Map<number, { type: string; mime: string | null }>();
  const iinf = kid('iinf');
  if (iinf) {
    const v = b[iinf.start];
    const first = iinf.start + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(b, view, first, iinf.end).filter((x) => x.type === 'infe')) {
      const iv = b[infe.start];
      if (iv < 2) continue;
      let p = infe.start + 4;
      const id = iv === 2 ? view.getUint16(p) : view.getUint32(p);
      p += iv === 2 ? 2 : 4;
      p += 2; // protection index
      const type = fourcc(b, p);
      p += 4;
      while (p < infe.end && b[p] !== 0) p++; // name
      p++;
      let mime: string | null = null;
      if (type === 'mime') {
        const s = p;
        while (p < infe.end && b[p] !== 0) p++;
        mime = new TextDecoder().decode(b.subarray(s, p));
      }
      items.set(id, { type, mime });
    }
  }

  // Where each item's bytes are.
  const idat = kid('idat');
  const where = new Map<number, Array<[number, number]>>();
  const iloc = kid('iloc');
  if (iloc) {
    const v = b[iloc.start];
    let p = iloc.start + 4;
    const offSize = b[p] >> 4;
    const lenSize = b[p] & 15;
    const baseSize = b[p + 1] >> 4;
    const idxSize = v >= 1 ? b[p + 1] & 15 : 0;
    p += 2;
    const read = (n: number) => {
      const val = n === 8 ? Number(view.getBigUint64(p)) : n === 4 ? view.getUint32(p) : n === 2 ? view.getUint16(p) : 0;
      p += n;
      return val;
    };
    const count = v < 2 ? read(2) : read(4);
    for (let k = 0; k < count && p < iloc.end; k++) {
      const id = v < 2 ? read(2) : read(4);
      const method = v >= 1 ? read(2) & 15 : 0;
      read(2); // data reference index
      const base = read(baseSize);
      const extents = read(2);
      const parts: Array<[number, number]> = [];
      for (let e = 0; e < extents; e++) {
        if (idxSize) read(idxSize);
        const off = read(offSize);
        const len = read(lenSize);
        const from = (method === 1 ? (idat?.start ?? 0) : 0) + base + off;
        parts.push([from, len]);
      }
      if (method === 0 || (method === 1 && idat)) where.set(id, parts);
    }
  }
  const itemBytes = (id: number): Uint8Array | null => {
    const parts = where.get(id);
    if (!parts) return null;
    if (parts.some(([o, l]) => o + l > b.length)) return null;
    if (parts.length === 1) return b.subarray(parts[0][0], parts[0][0] + parts[0][1]);
    const out = new Uint8Array(parts.reduce((n, [, l]) => n + l, 0));
    let at = 0;
    for (const [o, l] of parts) {
      out.set(b.subarray(o, o + l), at);
      at += l;
    }
    return out;
  };

  let exif: Uint8Array | null = null;
  let xmp: string | null = null;
  for (const [id, it] of items) {
    if (it.type === 'Exif' && !exif) {
      const data = itemBytes(id);
      // The item starts with where the TIFF header is, past a 4-byte length.
      if (data && data.length > 8) {
        const skip = new DataView(data.buffer, data.byteOffset).getUint32(0);
        const tiff = data.subarray(4 + skip);
        if (tiff.length > 8 && ((tiff[0] === 0x49 && tiff[1] === 0x49) || (tiff[0] === 0x4d && tiff[1] === 0x4d))) exif = tiff;
      }
    } else if (it.type === 'mime' && it.mime === 'application/rdf+xml' && xmp === null) {
      const data = itemBytes(id);
      if (data) xmp = new TextDecoder().decode(data);
    }
  }

  // The colour profile: the primary item's colr property, else the first ICC one there is.
  let icc: Uint8Array | null = null;
  const iprp = kid('iprp');
  if (iprp) {
    const ip = boxes(b, view, iprp.start, iprp.end);
    const ipco = ip.find((x) => x.type === 'ipco');
    const props = ipco ? boxes(b, view, ipco.start, ipco.end) : [];
    const profileOf = (box: Box | undefined) => {
      if (!box || box.type !== 'colr') return null;
      const kind = fourcc(b, box.start);
      return kind === 'prof' || kind === 'rICC' ? b.subarray(box.start + 4, box.end) : null;
    };
    const ipma = ip.find((x) => x.type === 'ipma');
    if (ipma && primary >= 0) {
      const v = b[ipma.start];
      const wide = (b[ipma.start + 3] & 1) === 1;
      let p = ipma.start + 4;
      const n = view.getUint32(p);
      p += 4;
      for (let k = 0; k < n && p < ipma.end; k++) {
        const id = v < 1 ? view.getUint16(p) : view.getUint32(p);
        p += v < 1 ? 2 : 4;
        const assoc = b[p++];
        for (let a = 0; a < assoc; a++) {
          const index = wide ? view.getUint16(p) & 0x7fff : b[p] & 0x7f;
          p += wide ? 2 : 1;
          if (id === primary && !icc) icc = profileOf(props[index - 1]);
        }
      }
    }
    if (!icc) for (const pr of props) if ((icc = profileOf(pr))) break;
  }
  return { exif, xmp, icc };
}
