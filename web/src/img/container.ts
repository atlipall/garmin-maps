import { ascii, ImgError, u16, u32 } from './bytes';
import type { ByteSource } from './source';

const FAT_ENTRY = 512;
/** Hard cap on how much of the file the FAT/header scan will read, however large the header
 *  claims to be — a malformed or hostile header shouldn't turn `open()` into a multi-GB read. */
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/** Fixed page size for `PageCache`. */
export const PAGE_SIZE = 65536;
/** Default page cache capacity, in pages (~8 MiB). */
export const DEFAULT_CACHE_PAGES = 128;

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

/**
 * LRU cache of fixed-size `PAGE_SIZE` pages backed by a `ByteSource`. `read(start, length)` fetches
 * whatever pages the range touches: pages already cached are reused, and every missing *run* of
 * consecutive pages is fetched with a single underlying `src.read` call (all runs for one request
 * go out in parallel), then split into pages. Concurrent requests that need the same page share
 * one in-flight fetch, so a page is never fetched twice at once. Eviction only affects the shared
 * cache; a call's own pages stay reachable (via `got`) even if fetching them overflows the cap.
 * Exported only so tests can construct one directly and use `debugBufferSizes`.
 */
export class PageCache {
  private readonly pages = new Map<number, Uint8Array>(); // insertion/access order: oldest (LRU) first
  private readonly pending = new Map<number, Promise<Map<number, Uint8Array>>>();

  constructor(
    private readonly src: ByteSource,
    private readonly cap: number,
  ) {}

  async read(start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const end = start + length;
    const firstPage = Math.floor(start / PAGE_SIZE);
    const lastPage = Math.floor((end - 1) / PAGE_SIZE);

    const got = new Map<number, Uint8Array>();
    const waits: Promise<void>[] = [];
    let runStart = -1;
    const flushRun = (runEnd: number) => {
      if (runStart === -1) return;
      const fetched = this.fetchRun(runStart, runEnd);
      waits.push(fetched.then((pages) => void pages.forEach((v, k) => got.set(k, v))));
      runStart = -1;
    };
    for (let p = firstPage; p <= lastPage; p++) {
      const cached = this.pages.get(p);
      if (cached !== undefined) {
        flushRun(p - 1);
        this.touch(p);
        got.set(p, cached);
        continue;
      }
      const pending = this.pending.get(p);
      if (pending) {
        flushRun(p - 1);
        waits.push(pending.then((pages) => void got.set(p, pages.get(p)!)));
        continue;
      }
      if (runStart === -1) runStart = p;
    }
    flushRun(lastPage);
    await Promise.all(waits);

    const out = new Uint8Array(length);
    let opos = 0;
    for (let p = firstPage; p <= lastPage; p++) {
      const page = got.get(p)!;
      const pageStart = p * PAGE_SIZE;
      const from = Math.max(start, pageStart) - pageStart;
      const to = Math.min(end, pageStart + page.length) - pageStart;
      if (to <= from) break; // real EOF inside this page: nothing further is available
      out.set(page.subarray(from, to), opos);
      opos += to - from;
    }
    return opos === length ? out : out.subarray(0, opos);
  }

  /** Test-only: the byte length of the backing `ArrayBuffer` for each currently cached page.
   *  Pages are stored as copies (see `doFetch`), so this should never exceed `PAGE_SIZE` — a
   *  `subarray` view into a multi-page fetched run would report that whole run's length instead. */
  debugBufferSizes(): number[] {
    return [...this.pages.values()].map((p) => p.buffer.byteLength);
  }

  private touch(p: number): void {
    const v = this.pages.get(p);
    if (v === undefined) return;
    this.pages.delete(p);
    this.pages.set(p, v);
  }

  /** Fetches pages `[first, last]` with one `src.read` call, sharing the resulting promise with
   *  any concurrent caller that asks for one of the same pages before it resolves. `pending` is
   *  cleared for these pages once the fetch settles, whether it succeeds or fails, so a rejected
   *  read doesn't wedge those pages: the next `read()` call for one just retries with a fresh
   *  fetch instead of replaying the same stale rejection forever. */
  private fetchRun(first: number, last: number): Promise<Map<number, Uint8Array>> {
    const promise = this.doFetch(first, last).finally(() => {
      for (let p = first; p <= last; p++) this.pending.delete(p);
    });
    for (let p = first; p <= last; p++) this.pending.set(p, promise);
    return promise;
  }

  private async doFetch(first: number, last: number): Promise<Map<number, Uint8Array>> {
    const start = first * PAGE_SIZE;
    const bytes = await this.src.read(start, (last - first + 1) * PAGE_SIZE);
    const fetched = new Map<number, Uint8Array>();
    for (let p = first; p <= last; p++) {
      const off = (p - first) * PAGE_SIZE;
      // Copy (not a subarray view) so an evicted-elsewhere page doesn't keep the whole run's
      // backing buffer alive: the cap then really bounds memory to about cap * PAGE_SIZE.
      const page = off < bytes.length ? bytes.slice(off, Math.min(bytes.length, off + PAGE_SIZE)) : new Uint8Array(0);
      fetched.set(p, page);
      this.pages.set(p, page);
      if (this.pages.size > this.cap) this.pages.delete(this.pages.keys().next().value!);
    }
    return fetched;
  }
}

export class ImgContainer {
  private constructor(
    private readonly pageCache: PageCache,
    private readonly blockSize: number,
    private readonly subfiles: Map<string, SubfileInfo>,
  ) {}

  static async open(src: ByteSource, cachePages = DEFAULT_CACHE_PAGES): Promise<ImgContainer> {
    let head = await src.read(0, Math.min(src.size, 0x10000));
    if (head.length < 0x200) throw new ImgError('not a Garmin IMG file (too small)');
    if (head[0] !== 0) {
      throw new ImgError(`XOR-scrambled IMG (xor byte 0x${head[0].toString(16).padStart(2, '0')}) is not supported`);
    }
    if (ascii(head, 0x10, 0x16) !== 'DSKIMG') throw new ImgError('not a Garmin IMG file (missing DSKIMG signature)');
    const blockSize = 2 ** (head[0x61] + head[0x62]);
    let scan = scanFat(head);
    if (scan.headerEnd !== null && scan.headerEnd > MAX_HEADER_BYTES) {
      throw new ImgError(`header claims an implausible size (${scan.headerEnd} bytes)`);
    }
    const want = scan.headerEnd ?? Math.min(src.size, 4 * 1024 * 1024);
    if (want > head.length) {
      head = await src.read(0, Math.min(src.size, want, MAX_HEADER_BYTES));
      scan = scanFat(head);
    }
    if (scan.parts.size === 0) throw new ImgError('no subfiles found in the IMG FAT');
    const subfiles = new Map<string, SubfileInfo>();
    for (const [key, entry] of scan.parts) {
      const nums = [...entry.parts.keys()].sort((a, b) => a - b);
      if (nums.some((n, i) => n !== i)) throw new ImgError(`${key}: FAT parts [${nums}] are not contiguous from 0`);
      const blocks = nums.flatMap((n) => entry.parts.get(n)!);
      if (entry.size > blocks.length * blockSize) {
        throw new ImgError(`${key}: declared size ${entry.size} exceeds its ${blocks.length} block(s) of ${blockSize} bytes`);
      }
      subfiles.set(key, { size: entry.size, blocks });
    }
    return new ImgContainer(new PageCache(src, cachePages), blockSize, subfiles);
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
      const chunk = await this.pageCache.read(sf.blocks[bi] * bs + (pos % bs), runEnd - pos);
      if (chunk.length !== runEnd - pos) throw new ImgError(`${name}: IMG file truncated`);
      out.set(chunk, pos - start);
      pos = runEnd;
    }
    return out;
  }
}
