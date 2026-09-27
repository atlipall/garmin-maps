import { ascii, ImgError, u16, u32 } from './bytes';
import type { ByteSource } from './source';

const FAT_ENTRY = 512;

interface SubfileInfo {
  size: number;
  blocks: number[];
}

interface ScanResult {
  headerEnd: number | null;
  parts: Map<string, { size: number; parts: Map<number, number[]> }>;
}

function scanFat(data: Uint8Array): ScanResult {
  const parts: ScanResult['parts'] = new Map();
  let headerEnd: number | null = null;
  let started = false;
  let off = 0x200;
  while (off + FAT_ENTRY <= data.length) {
    if (headerEnd !== null && off >= headerEnd) break;
    const e = data.subarray(off, off + FAT_ENTRY);
    off += FAT_ENTRY;
    if (e[0] !== 1) {
      if (started) {
        if (headerEnd !== null) continue; // header size known: skip free slots
        break;
      }
      continue;
    }
    started = true;
    const name = ascii(e, 1, 9).trim();
    const ext = ascii(e, 9, 12).trim();
    const size = u32(e, 0x0c);
    const part = (e[0x10] << 8) | e[0x11];
    const blocks: number[] = [];
    for (let i = 0; i < 240; i++) {
      const b = u16(e, 0x20 + 2 * i);
      if (b !== 0xffff) blocks.push(b);
    }
    if (!name && !ext) {
      headerEnd = size; // this entry describes the header area; its size ends the FAT
      continue;
    }
    const key = `${name}.${ext}`;
    let entry = parts.get(key);
    if (!entry) {
      entry = { size: 0, parts: new Map() };
      parts.set(key, entry);
    }
    if (part === 0) entry.size = size;
    entry.parts.set(part, blocks);
  }
  return { headerEnd, parts };
}

export class ImgContainer {
  private constructor(
    private readonly src: ByteSource,
    private readonly blockSize: number,
    private readonly subfiles: Map<string, SubfileInfo>,
  ) {}

  static async open(src: ByteSource): Promise<ImgContainer> {
    let head = await src.read(0, Math.min(src.size, 0x10000));
    if (head.length < 0x200) throw new ImgError('not a Garmin IMG file (too small)');
    if (head[0] !== 0) {
      throw new ImgError(`XOR-scrambled IMG (xor byte 0x${head[0].toString(16).padStart(2, '0')}) is not supported`);
    }
    if (ascii(head, 0x10, 0x16) !== 'DSKIMG') throw new ImgError('not a Garmin IMG file (missing DSKIMG signature)');
    const blockSize = 2 ** (head[0x61] + head[0x62]);
    let scan = scanFat(head);
    const want = scan.headerEnd ?? Math.min(src.size, 4 * 1024 * 1024);
    if (want > head.length) {
      head = await src.read(0, Math.min(src.size, want));
      scan = scanFat(head);
    }
    if (scan.parts.size === 0) throw new ImgError('no subfiles found in the IMG FAT');
    const subfiles = new Map<string, SubfileInfo>();
    for (const [key, entry] of scan.parts) {
      const nums = [...entry.parts.keys()].sort((a, b) => a - b);
      if (nums.some((n, i) => n !== i)) throw new ImgError(`${key}: FAT parts [${nums}] are not contiguous from 0`);
      subfiles.set(key, { size: entry.size, blocks: nums.flatMap((n) => entry.parts.get(n)!) });
    }
    return new ImgContainer(src, blockSize, subfiles);
  }

  tileIds(): string[] {
    return [...this.subfiles.keys()].filter((k) => k.endsWith('.TRE')).map((k) => k.slice(0, -4)).sort();
  }

  has(name: string): boolean {
    return this.subfiles.has(name);
  }

  size(name: string): number {
    const sf = this.subfiles.get(name);
    if (!sf) throw new ImgError(`${name}: subfile not found`);
    return sf.size;
  }

  firstOfType(ext: string): string | undefined {
    return [...this.subfiles.keys()].sort().find((k) => k.endsWith(`.${ext}`));
  }

  async read(name: string, start = 0, length?: number): Promise<Uint8Array> {
    const sf = this.subfiles.get(name);
    if (!sf) throw new ImgError(`${name}: subfile not found`);
    const end = Math.min(sf.size, length === undefined ? sf.size : start + length);
    if (start >= end) return new Uint8Array(0);
    const bs = this.blockSize;
    const out = new Uint8Array(end - start);
    let pos = start;
    while (pos < end) {
      const bi = Math.floor(pos / bs);
      if (bi >= sf.blocks.length) throw new ImgError(`${name}: block list shorter than subfile size`);
      let run = 1;
      while (bi + run < sf.blocks.length && sf.blocks[bi + run] === sf.blocks[bi] + run && (bi + run) * bs < end) run++;
      const runEnd = Math.min(end, (bi + run) * bs);
      const chunk = await this.src.read(sf.blocks[bi] * bs + (pos % bs), runEnd - pos);
      if (chunk.length !== runEnd - pos) throw new ImgError(`${name}: IMG file truncated`);
      out.set(chunk, pos - start);
      pos = runEnd;
    }
    return out;
  }
}
