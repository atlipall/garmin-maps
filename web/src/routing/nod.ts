/**
 * Reader for Garmin's routing network (the NOD subfile): nodes with their arcs to neighbouring
 * nodes, each arc linked to a road record ("Table A") with speed class, road class, one-way and
 * toll flags and a pointer to the road in NET. Written from the public reverse-engineering notes
 * (OSM wiki "NOD Subfile Format", mkgmap's doc/nod.txt) and a study of how mkgmap writes the format.
 */

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s24 = (v: number) => (v & 0x800000 ? v - 0x1000000 : v);
const signed = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);

export interface NodHeader {
  nod1: { offset: number; length: number };
  nod2: { offset: number; length: number };
  nod3: { offset: number; length: number; record: number };
  flags: number;
  /** Tables areas start on multiples of 1 << align. */
  align: number;
  tableARecord: number;
}

export function parseNodHeader(h: Uint8Array): NodHeader {
  return {
    nod1: { offset: u32(h, 0x15), length: u32(h, 0x19) },
    flags: u32(h, 0x1d),
    align: h[0x21],
    tableARecord: u16(h, 0x23),
    nod2: { offset: u32(h, 0x25), length: u32(h, 0x29) },
    nod3: { offset: u32(h, 0x31), length: u32(h, 0x35), record: h[0x39] },
  };
}

/** Start nodes (NOD1 offsets) of every road, from the NOD2 road records. */
export function nod2StartNodes(nod2: Uint8Array): number[] {
  const out: number[] = [];
  let p = 0;
  while (p + 6 <= nod2.length) {
    out.push(u24(nod2, p + 1));
    const nbits = u16(nod2, p + 4);
    p += 6 + Math.ceil(nbits / 8);
  }
  return out;
}

export interface NodArc {
  target: number;
  /** Raw length in NOD units. */
  length: number;
  forward: boolean;
  /** Table A record: pointer into NET, class/speed/one-way/toll byte, access byte. */
  net: number;
  info: number;
  access: number;
  /** The first arc of its road-and-direction group: a link to the adjacent node. The others in the
   *  group are "indirect" links further along the same road, whose length field is not the road
   *  length to their target; routing uses direct links only. */
  direct: boolean;
}

export interface NodNode {
  offset: number;
  flags: number;
  /** Map units. */
  x: number;
  y: number;
  arcs: NodArc[];
  /** Offset just past the arcs (before any restriction offsets). */
  end: number;
}

/** More links than this from one node means the data is damaged. */
const MAX_ARCS = 64;

/** Decodes the node record at `off` in NOD1. */
export function parseNode(nod1: Uint8Array, off: number, hdr: NodHeader): NodNode {
  const align = hdr.align;
  const tables = ((off >> align) + nod1[off] + 1) << align;
  const nA = nod1[tables + 7];
  const tableA = tables + 9;
  const tableB = tableA + nA * hdr.tableARecord;
  const baseX = s24(u24(nod1, tables + 1));
  const baseY = s24(u24(nod1, tables + 4));
  const flags = nod1[off + 1];
  let p = off + 2;
  let dx: number;
  let dy: number;
  if (flags & 0x20) {
    const v = u32(nod1, p);
    dx = signed(v & 0xffff, 16);
    dy = signed(v >>> 16, 16);
    p += 4;
  } else {
    const v = u24(nod1, p);
    dx = signed(v & 0xfff, 12);
    dy = signed(v >>> 12, 12);
    p += 3;
  }
  const node: NodNode = { offset: off, flags, x: baseX + dx, y: baseY + dy, arcs: [], end: p };
  if (!(flags & 0x40)) return node;

  let first = true;
  let compact = false;
  let dirByteHalf = 0; // compact directions: 0 = next direction reads a new byte
  let indexA = -1;
  let prevForward = false;
  for (;;) {
    // A record that runs off the end of the data (a truncated or damaged map), or one with more
    // links than any junction has: stop here rather than reading on forever.
    if (p + 2 > nod1.length || node.arcs.length >= MAX_ARCS) break;
    const fa = nod1[p++];
    const fb = nod1[p++];
    let target: number;
    if (!(fb & 0x40)) {
      target = off + signed(((fb & 0x3f) << 8) | nod1[p++], 14);
    } else {
      let ib = fb & 0x3f;
      if (ib === 0x3f) ib = nod1[p++];
      target = u24(nod1, tableB + ib * 3);
    }
    if (first) compact = (fa & 0x80) !== 0;
    const newNet = first || (fa & 0x80) !== 0;
    if (newNet) indexA = nod1[p++];
    let length: number;
    let curve: boolean;
    if ((fa & 0x38) !== 0x38) {
      length = ((fa & 0x18) << 5) | nod1[p++];
      curve = (fa & 0x20) !== 0;
    } else {
      const b0 = nod1[p];
      if (b0 & 0x80) {
        if (b0 & 0x40) {
          length = (b0 & 0x3f) | (nod1[p + 1] << 6) | (nod1[p + 2] << 14);
          p += 3;
          curve = true;
        } else {
          length = (b0 & 0x3f) | (nod1[p + 1] << 6);
          p += 2;
          curve = false;
        }
      } else {
        length = (b0 & 0x7f) | (nod1[p + 1] << 7);
        p += 2;
        curve = true;
      }
    }
    const forward = (fa & 0x40) !== 0;
    const direct = first || newNet || forward !== prevForward;
    if (direct) {
      if (!compact) p++;
      else {
        if (dirByteHalf === 0) p++;
        dirByteHalf ^= 1;
      }
    }
    if (curve) {
      const c = nod1[p++];
      if ((c & 0xe0) === 0) p++;
    }
    const a = tableA + indexA * hdr.tableARecord;
    node.arcs.push({ target, length, forward, direct, net: u24(nod1, a) & 0x3fffff, info: nod1[a + 3], access: nod1[a + 4] });
    prevForward = forward;
    first = false;
    if (fb & 0x80) break;
  }
  node.end = p;
  return node;
}

/** All nodes reachable from the road start nodes, by offset. */
export function readNodes(nod1: Uint8Array, nod2: Uint8Array, hdr: NodHeader): Map<number, NodNode> {
  const nodes = new Map<number, NodNode>();
  const queue = nod2StartNodes(nod2);
  while (queue.length) {
    const off = queue.pop()!;
    if (nodes.has(off) || off < 0 || off >= nod1.length) continue;
    const n = parseNode(nod1, off, hdr);
    nodes.set(off, n);
    for (const a of n.arcs) if (!nodes.has(a.target)) queue.push(a.target);
  }
  return nodes;
}
