export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesOf(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function packS24(v: number): Uint8Array {
  const u = v & 0xffffff;
  return new Uint8Array([u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff]);
}

function fatEntry(name: string, ext: string, size: number, part: number, blocks: number[]): Uint8Array {
  const e = new Uint8Array(512);
  const dv = new DataView(e.buffer);
  e[0] = 1;
  e.set(bytesOf(name.padEnd(8)), 1);
  e.set(bytesOf(ext.padEnd(3)), 9);
  dv.setUint32(0x0c, size, true);
  e[0x10] = part >> 8;
  e[0x11] = part & 0xff;
  for (let i = 0; i < 240; i++) dv.setUint16(0x20 + 2 * i, i < blocks.length ? blocks[i] : 0xffff, true);
  return e;
}

/** Build a minimal Garmin IMG disk image holding `files` ({"NAME.EXT": bytes}). */
export function buildImg(files: Record<string, Uint8Array>, blockSize = 512, blocksPerEntry = 240): Uint8Array {
  const layout: Array<[string, Uint8Array, number]> = [];
  let fatEntries = 1;
  for (const [name, data] of Object.entries(files)) {
    const nblocks = Math.max(1, Math.ceil(data.length / blockSize));
    fatEntries += Math.ceil(nblocks / blocksPerEntry);
    layout.push([name, data, nblocks]);
  }
  const headerEnd = Math.ceil((0x200 + 512 * fatEntries) / blockSize) * blockSize;
  const hdr = new Uint8Array(headerEnd);
  hdr.set(bytesOf('DSKIMG'), 0x10);
  hdr[0x61] = 9;
  hdr[0x62] = Math.log2(blockSize) - 9;
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  hdr.set(fatEntry('', '', headerEnd, 0, range(0, headerEnd / blockSize)), 0x200);
  const body: Uint8Array[] = [];
  let next = headerEnd / blockSize;
  let off = 0x400;
  for (const [fname, data, nblocks] of layout) {
    const [name, ext] = fname.split('.');
    const blocks = range(next, next + nblocks);
    for (let part = 0, i = 0; i < nblocks; part++, i += blocksPerEntry) {
      hdr.set(fatEntry(name, ext, part === 0 ? data.length : 0, part, blocks.slice(i, i + blocksPerEntry)), off);
      off += 512;
    }
    const padded = new Uint8Array(nblocks * blockSize);
    padded.set(data);
    body.push(padded);
    next += nblocks;
  }
  return concat(hdr, ...body);
}

export function makeRgnHeader(dataLen: number, ext: Array<[number, number]> = [[0, 0], [0, 0], [0, 0]], hlen = 0x7d): Uint8Array {
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN RGN'), 2);
  dv.setUint32(0x15, hlen, true);
  dv.setUint32(0x19, dataLen, true);
  ext.forEach(([o, n], i) => {
    const at = [0x1d, 0x39, 0x55][i];
    dv.setUint32(at, o, true);
    dv.setUint32(at + 4, n, true);
  });
  return h;
}

/** levels: [number, bits, inherited, count]; subdivs: [rgnOffset, kinds, cx, cy] in level order;
 *  extRecords: [poly2, line2, point2] offsets (one per subdivision + sentinel). Half-width/height are 10. */
export function makeTre(
  levels: Array<[number, number, boolean, number]>,
  subdivs: Array<[number, number, number, number]>,
  extRecords: Array<[number, number, number]> = [],
  bounds: [number, number, number, number] = [1000, 1000, -1000, -1000],
  hlen = 0xbc,
): Uint8Array {
  const h = new Uint8Array(hlen);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, hlen, true);
  h.set(bytesOf('GARMIN TRE'), 2);
  bounds.forEach((v, i) => h.set(packS24(v), 0x15 + 3 * i));
  const lv = concat(...levels.map(([num, bits, inh, cnt]) => new Uint8Array([num | (inh ? 0x80 : 0), bits, cnt & 0xff, cnt >> 8])));
  const sd: number[] = [];
  let i = 0;
  levels.forEach(([, , , cnt], li) => {
    const last = li === levels.length - 1;
    for (let k = 0; k < cnt; k++) {
      const [rgnOff, kinds, cx, cy] = subdivs[i++];
      sd.push(rgnOff & 0xff, (rgnOff >> 8) & 0xff, (rgnOff >> 16) & 0xff, kinds, ...packS24(cx), ...packS24(cy), 10, 0, 10, 0);
      if (!last) sd.push(0, 0);
    }
  });
  const ext = new Uint8Array(13 * extRecords.length);
  const edv = new DataView(ext.buffer);
  extRecords.forEach(([a, b, c], j) => {
    edv.setUint32(13 * j, a, true);
    edv.setUint32(13 * j + 4, b, true);
    edv.setUint32(13 * j + 8, c, true);
  });
  const lvOff = hlen;
  const sdOff = lvOff + lv.length;
  const extOff = sdOff + sd.length;
  dv.setUint32(0x21, lvOff, true);
  dv.setUint32(0x25, lv.length, true);
  dv.setUint32(0x29, sdOff, true);
  dv.setUint32(0x2d, sd.length, true);
  dv.setUint32(0x7c, extOff, true);
  dv.setUint32(0x80, ext.length, true);
  dv.setUint16(0x84, ext.length ? 13 : 0, true);
  return concat(h, lv, new Uint8Array(sd), ext);
}
