import { describe, expect, test } from 'vitest';
import { ImgError } from '../src/img/bytes';
import { ImgContainer, PAGE_SIZE, PageCache } from '../src/img/container';
import { BlobSource } from '../src/img/source';
import type { ByteSource } from '../src/img/source';
import { buildImg, bytesOf } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

/** Wraps a ByteSource and records every `read` call, so tests can assert how many (and which)
 *  physical reads the page cache actually issued. */
class CountingSource implements ByteSource {
  readonly calls: Array<[number, number]> = [];
  constructor(private readonly inner: ByteSource) {}
  get size(): number {
    return this.inner.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.calls.push([offset, length]);
    return this.inner.read(offset, length);
  }
}

/** Wraps a ByteSource so a single armed call rejects; the next call after that (and every call
 *  before arming) is delegated normally. Lets a test fail exactly one fetch on demand. */
class FlakySource implements ByteSource {
  private armed = false;
  constructor(private readonly inner: ByteSource) {}
  get size(): number {
    return this.inner.size;
  }
  armFailure(): void {
    this.armed = true;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.armed) {
      this.armed = false;
      throw new Error('injected read failure');
    }
    return this.inner.read(offset, length);
  }
}

const openCounting = async (data: Uint8Array, cachePages?: number) => {
  const counting = new CountingSource(new BlobSource(new Blob([new Uint8Array(data)])));
  const img = await ImgContainer.open(counting, cachePages);
  return { img, counting };
};

const open = (bytes: Uint8Array) => ImgContainer.open(new BlobSource(new Blob([new Uint8Array(bytes)])));
const filled = (n: number, c: string) => new Uint8Array(n).fill(c.charCodeAt(0));

describe('ImgContainer', () => {
  test('reads subfiles', async () => {
    const img = await open(buildImg({ '00000001.TRE': filled(700, 'T'), '00000001.RGN': filled(10, 'R'), '103F2.TYP': filled(3, 'Y') }));
    expect(img.tileIds()).toEqual(['00000001']);
    expect(await img.read('00000001.TRE')).toEqual(filled(700, 'T'));
    expect(await img.read('00000001.TRE', 690, 20)).toEqual(filled(10, 'T'));
    expect(img.firstOfType('TYP')).toBe('103F2.TYP');
    expect(img.has('missing.XYZ')).toBe(false);
  });

  test('joins multi-part entries and reads across blocks', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => i % 256);
    const img = await open(buildImg({ 'A.RGN': data }, 512, 3));
    expect(await img.read('A.RGN')).toEqual(data);
    expect(await img.read('A.RGN', 500, 1100)).toEqual(data.subarray(500, 1600));
  });

  test('rejects non-IMG and scrambled images', async () => {
    await expect(open(new Uint8Array(4096))).rejects.toThrow(/DSKIMG/);
    const raw = buildImg({ 'A.TRE': bytesOf('x') });
    raw[0] = 0x5a;
    await expect(open(raw)).rejects.toThrow(/XOR/);
  });

  test('rejects duplicate part numbers', async () => {
    const raw = buildImg({ 'A.RGN': new Uint8Array(5120) }, 512, 3);
    raw[0x600 + 0x10] = 0;
    raw[0x600 + 0x11] = 0;
    await expect(open(raw)).rejects.toThrow(ImgError);
  });

  test('assembles parts stored out of order', async () => {
    const data = Uint8Array.from({ length: 5120 }, (_, i) => (i * 7) % 256);
    const raw = buildImg({ 'A.RGN': data }, 512, 3);
    const a = raw.slice(0x600, 0x800);
    raw.set(raw.slice(0x800, 0xa00), 0x600);
    raw.set(a, 0x800);
    expect(await (await open(raw)).read('A.RGN')).toEqual(data);
  });

  test('rejects a header claiming an implausibly large size', async () => {
    // The header-description FAT entry (empty name+ext, at absolute 0x200 — see scanFat/buildImg)
    // carries the header size in its `size` field (offset 0x0c within the entry); a corrupt or
    // hostile image can claim an enormous one to force a huge read.
    const raw = buildImg({ 'A.TRE': filled(10, 'a') });
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(0x200 + 0x0c, 100 * 1024 * 1024, true);
    await expect(open(raw)).rejects.toThrow(ImgError);
    await expect(open(raw)).rejects.toThrow(/implausible/);
  });

  test('rejects a subfile whose declared size exceeds its block list', async () => {
    // A single 512-byte block can hold at most 512 bytes; claim far more in the FAT entry's size
    // field (the first per-subfile FAT entry sits at absolute 0x400 — see buildImg).
    const raw = buildImg({ 'A.RGN': filled(512, 'a') }, 512);
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(0x400 + 0x0c, 10_000, true);
    await expect(open(raw)).rejects.toThrow(ImgError);
    await expect(open(raw)).rejects.toThrow(/A\.RGN/);
  });

  test('skips a zeroed FAT slot between entries', async () => {
    const raw = buildImg({ 'A.TRE': filled(10, 'a'), 'B.TRE': filled(10, 'b'), 'C.TRE': filled(10, 'c') });
    raw.fill(0, 0x600, 0x800);
    const img = await open(raw);
    expect(await img.read('A.TRE')).toEqual(filled(10, 'a'));
    expect(await img.read('C.TRE')).toEqual(filled(10, 'c'));
    expect(img.has('B.TRE')).toBe(false);
  });
});

describe('ImgContainer page cache', () => {
  test('reads through the cache equal direct reads, across page boundaries and up to EOF', async () => {
    // A single subfile whose data length is an exact multiple of the block size, so the built
    // image ends exactly at the physical end of the backing Blob with no block-padding slack.
    const blockSize = 512;
    const nblocks = 281; // 281 * 512 = 143,872 bytes: not a multiple of PAGE_SIZE (65536).
    const data = Uint8Array.from({ length: nblocks * blockSize }, (_, i) => i % 256);
    const { img } = await openCounting(buildImg({ 'A.RGN': data }, blockSize));

    // Spans a page boundary.
    expect(await img.read('A.RGN', PAGE_SIZE - 100, 300)).toEqual(data.subarray(PAGE_SIZE - 100, PAGE_SIZE + 200));
    // Starts and ends inside the same page, well past the first boundary.
    expect(await img.read('A.RGN', PAGE_SIZE + 40000, 5000)).toEqual(data.subarray(PAGE_SIZE + 40000, PAGE_SIZE + 45000));
    // The whole subfile: its end lands exactly at EOF of the underlying Blob.
    expect(await img.read('A.RGN')).toEqual(data);
  });

  test('repeated reads of the same range hit the source only once', async () => {
    const data = Uint8Array.from({ length: 3 * PAGE_SIZE }, (_, i) => i % 256);
    const { img, counting } = await openCounting(buildImg({ 'A.RGN': data }, 512));

    const first = await img.read('A.RGN', PAGE_SIZE + 100, 400);
    const afterFirst = counting.calls.length;
    const second = await img.read('A.RGN', PAGE_SIZE + 100, 400);
    expect(second).toEqual(first);
    expect(counting.calls.length).toBe(afterFirst); // no new source read on the repeat
  });

  test('two concurrent reads of the same page issue one source read', async () => {
    const data = Uint8Array.from({ length: 3 * PAGE_SIZE }, (_, i) => i % 256);
    const { img, counting } = await openCounting(buildImg({ 'A.RGN': data }, 512));

    const before = counting.calls.length;
    const [a, b] = await Promise.all([
      img.read('A.RGN', PAGE_SIZE + 100, 50), // same page (page 1), issued concurrently
      img.read('A.RGN', PAGE_SIZE + 200, 50),
    ]);
    expect(a).toEqual(data.subarray(PAGE_SIZE + 100, PAGE_SIZE + 150));
    expect(b).toEqual(data.subarray(PAGE_SIZE + 200, PAGE_SIZE + 250));
    expect(counting.calls.length - before).toBe(1); // one fetch served both concurrent reads
  });

  test('LRU eviction happens at the cap', async () => {
    const data = Uint8Array.from({ length: 3 * PAGE_SIZE }, (_, i) => i % 256);
    const { img, counting } = await openCounting(buildImg({ 'A.RGN': data }, 512), 2); // cap = 2 pages

    await img.read('A.RGN', 100, 10); // page 0
    await img.read('A.RGN', PAGE_SIZE + 100, 10); // page 1: cache now at cap {0, 1}
    const afterTwo = counting.calls.length;

    await img.read('A.RGN', 2 * PAGE_SIZE + 100, 10); // page 2: over cap, evicts page 0 (LRU)
    expect(counting.calls.length).toBe(afterTwo + 1);

    const afterThree = counting.calls.length;
    const again = await img.read('A.RGN', 100, 10); // page 0 again: was evicted, must be refetched
    expect(counting.calls.length).toBe(afterThree + 1);
    expect(again).toEqual(data.subarray(100, 110));
  });

  test('a physically truncated file still raises ImgError', async () => {
    const data = Uint8Array.from({ length: 3 * PAGE_SIZE }, (_, i) => i % 256);
    const raw = buildImg({ 'A.RGN': data }, 512);
    const truncated = raw.slice(0, raw.length - 100); // simulate a file cut short on disk
    const { img } = await openCounting(truncated);
    await expect(img.read('A.RGN')).rejects.toThrow(ImgError);
    await expect(img.read('A.RGN')).rejects.toThrow(/truncated/);
  });

  test('a rejected in-flight fetch does not poison its pages forever', async () => {
    const data = Uint8Array.from({ length: 3 * PAGE_SIZE }, (_, i) => i % 256);
    const raw = buildImg({ 'A.RGN': data }, 512);
    const flaky = new FlakySource(new BlobSource(new Blob([new Uint8Array(raw)])));
    const img = await ImgContainer.open(flaky); // FAT scan happens before arming: unaffected

    flaky.armFailure();
    await expect(img.read('A.RGN', 100, 10)).rejects.toThrow(/injected read failure/);

    // The failed page must not be stuck "pending" forever: a fresh read retries and succeeds.
    const again = await img.read('A.RGN', 100, 10);
    expect(again).toEqual(data.subarray(100, 110));
  });

  test('cached pages are independent copies, not views into a shared run buffer', async () => {
    // A single read spanning several pages issues one src.read() call covering all of them; if
    // pages were stored as subarray views into that one run buffer, every page's `.buffer` would
    // report the whole run's byte length instead of just its own PAGE_SIZE-or-smaller slice.
    const data = Uint8Array.from({ length: 6 * PAGE_SIZE }, (_, i) => i % 256);
    const cache = new PageCache(new BlobSource(new Blob([new Uint8Array(data)])), 100);
    await cache.read(0, data.length);
    const sizes = cache.debugBufferSizes();
    expect(sizes.length).toBe(6);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(PAGE_SIZE);
  });
});

describe.skipIf(!hasRealData)('ImgContainer on real data', () => {
  test('Detailed IMG', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    expect(img.tileIds()).toEqual(['14057401', '14057402', '14057403', '14057405', '14057406']);
    expect(img.size('14057403.RGN')).toBe(17504055);
    const typ = await img.read(img.firstOfType('TYP')!, 0, 12);
    expect(String.fromCharCode(...typ.subarray(2, 12))).toBe('GARMIN TYP');
    await src.close();
  });
});
