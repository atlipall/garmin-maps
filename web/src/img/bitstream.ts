/** Delta-coded polyline/polygon geometry (port of QMapShack's CShiftReg). */
export interface SignInfo {
  xSigned: boolean;
  xNeg: boolean;
  ySigned: boolean;
  yNeg: boolean;
  headerBits: number;
}

export function coordBits(base: number, signed: boolean): number {
  const n = 2 + (base <= 9 ? base : 2 * base - 9);
  return signed ? n + 1 : n;
}

export function setup(baseInfo: number, first: number, v2: boolean): [number, number, SignInfo] {
  let mask = 1;
  let headerBits = 2;
  const xSame = (first & mask) !== 0;
  mask <<= 1;
  let xNeg = false;
  if (xSame) {
    xNeg = (first & mask) !== 0;
    mask <<= 1;
    headerBits += 1;
  }
  let bx = coordBits(baseInfo & 0x0f, !xSame);
  const ySame = (first & mask) !== 0;
  mask <<= 1;
  let yNeg = false;
  if (ySame) {
    yNeg = (first & mask) !== 0;
    mask <<= 1;
    headerBits += 1;
  }
  let by = coordBits((baseInfo >> 4) & 0x0f, !ySame);
  if (v2) {
    headerBits += 1;
    if (first & mask) {
      bx += 1;
      by += 1;
    }
  }
  return [bx, by, { xSigned: !xSame, xNeg, ySigned: !ySame, yNeg, headerBits }];
}

class BitReader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length * 8 - this.pos;
  }

  peek(n: number): number {
    let v = 0;
    let m = 1;
    for (let i = 0; i < n; i++) {
      const p = this.pos + i;
      const byte = p >> 3 < this.data.length ? this.data[p >> 3] : 0;
      if ((byte >> (p & 7)) & 1) v += m;
      m *= 2;
    }
    return v;
  }

  take(n: number): number {
    const v = this.peek(n);
    this.pos += n;
    return v;
  }
}

export function decodeDeltas(data: Uint8Array, baseInfo: number, v2: boolean, extraBit: boolean): Array<[number, number]> {
  if (data.length === 0) return [];
  const [bx, by, sign] = setup(baseInfo, data[0], v2);
  const r = new BitReader(data);
  r.pos = sign.headerBits;
  const per = bx + by + (extraBit ? 1 : 0);

  const value = (n: number, signed: boolean, neg: boolean): number => {
    if (!signed) {
      const v = r.take(n);
      return neg && v ? -v : v;
    }
    const signBit = 2 ** (n - 1);
    let acc = 0;
    let t = r.peek(n);
    while (t === signBit) {
      acc += t - 1;
      r.pos += n;
      t = r.peek(n);
    }
    r.pos += n;
    return t < signBit ? acc + t : t - 2 * signBit - acc;
  };

  const out: Array<[number, number]> = [];
  while (r.remaining >= per) {
    if (extraBit) r.pos += 1;
    const x = value(bx, sign.xSigned, sign.xNeg);
    const y = value(by, sign.ySigned, sign.yNeg);
    out.push([x, y]);
  }
  return out;
}
