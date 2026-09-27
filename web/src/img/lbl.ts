import { isNumber, pyRound } from '../map/zoom';
import { ascii, ImgError, u16, u24, u32, u8 } from './bytes';
import type { LabelSrc } from './rgn';

const FEET_TO_M = 0.3048;
const ELEVATION_SEPARATOR = 0x1f;

export function formatLabel(raw: Uint8Array, decoder: TextDecoder): string | null {
  const parts: Array<[number[], number]> = [];
  let buf: number[] = [];
  let prevSep = 0;
  for (const b of raw) {
    if (b >= 0x1b && b <= 0x1f) {
      if (buf.length) {
        parts.push([buf, prevSep]);
        buf = [];
      }
      prevSep = b;
    } else if (b >= 0x07) {
      buf.push(b);
    }
  }
  if (buf.length) parts.push([buf, prevSep]);
  const out: string[] = [];
  for (const [bytes, sep] of parts) {
    let s = decoder.decode(new Uint8Array(bytes)).trim();
    if (sep === ELEVATION_SEPARATOR && isNumber(s)) s = `${pyRound(parseFloat(s) * FEET_TO_M)} m`;
    if (s) out.push(s);
  }
  return out.length ? out.join(' ') : null;
}

function decoderFor(codepage: number): TextDecoder {
  const label = codepage === 65001 ? 'utf-8' : codepage ? `windows-${codepage}` : 'windows-1252';
  try {
    return new TextDecoder(label);
  } catch {
    throw new ImgError(`LBL: codepage ${codepage} not supported`);
  }
}

export class LabelTable {
  private readonly lbl1: number;
  private readonly shift: number;
  private readonly decoder: TextDecoder;
  private readonly poiOff: number;
  private readonly poiShift: number;
  private readonly net1: number;
  private readonly netShift: number;
  private readonly cache = new Map<number, string | null>();

  constructor(private readonly lbl: Uint8Array, private readonly net: Uint8Array | null) {
    if (ascii(lbl, 2, 12) !== 'GARMIN LBL') throw new ImgError('LBL: bad signature');
    const encoding = u8(lbl, 0x1e);
    if (encoding !== 9) throw new ImgError(`LBL: label encoding ${encoding} not supported (only 8-bit labels, encoding 9)`);
    this.lbl1 = u32(lbl, 0x15);
    this.shift = u8(lbl, 0x1d);
    this.decoder = decoderFor(u16(lbl, 0) >= 0xac ? u16(lbl, 0xaa) : 1252);
    this.poiOff = u32(lbl, 0x57);
    this.poiShift = u8(lbl, 0x5f);
    this.net1 = net ? u32(net, 0x15) : 0;
    this.netShift = net ? u8(net, 0x1d) : 0;
  }

  text(label: number, src: LabelSrc): string | null {
    if (src === 'lbl' && label === 0) return null;
    try {
      const off = this.resolve(label, src);
      if (!off) return null;
      let v = this.cache.get(off);
      if (v === undefined) {
        const start = this.lbl1 + off * 2 ** this.shift;
        let end = this.lbl.indexOf(0, start);
        if (end < 0) end = this.lbl.length;
        v = formatLabel(this.lbl.subarray(start, end), this.decoder);
        this.cache.set(off, v);
      }
      return v;
    } catch (err) {
      if (err instanceof RangeError) return null;
      throw err;
    }
  }

  private resolve(label: number, src: LabelSrc): number | null {
    if (src === 'poi') return u24(this.lbl, this.poiOff + label * 2 ** this.poiShift) & 0x3fffff;
    if (src === 'net') {
      if (!this.net) return null;
      const v = u24(this.net, this.net1 + label * 2 ** this.netShift);
      return v & 0x400000 ? null : v & 0x3fffff;
    }
    return label;
  }
}
