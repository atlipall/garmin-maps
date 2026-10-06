import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { firstEntry, ZipError } from '../src/storage/unzipStream';

/** A zip with one entry (local header, data, a stand-in for the central directory after it). */
function zip(name: string, data: Uint8Array, opts: { method?: number; flags?: number } = {}): Uint8Array {
  const method = opts.method ?? 8;
  const packed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
  const n = new TextEncoder().encode(name);
  const h = new Uint8Array(30 + n.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(6, opts.flags ?? 0, true);
  v.setUint16(8, method, true);
  v.setUint32(18, packed.length, true);
  v.setUint32(22, data.length, true);
  v.setUint16(26, n.length, true);
  h.set(n, 30);
  const dir = new Uint8Array([0x50, 0x4b, 1, 2, 9, 9, 9, 9]);
  const out = new Uint8Array(h.length + packed.length + dir.length);
  out.set(h);
  out.set(packed, h.length);
  out.set(dir, h.length + packed.length);
  return out;
}

/** The bytes as a stream of `size`-byte chunks, like a download. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({ pull(c) { if (at >= bytes.length) c.close(); else { c.enqueue(bytes.slice(at, at + size)); at += size; } } });
}

const all = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());
// Pseudo-random, so it doesn't pack down to almost nothing.
let seed = 1;
const data = Uint8Array.from({ length: 300_000 }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);

describe('firstEntry', () => {
  test('unpacks a deflated entry streamed in small chunks, and stops at its end', async () => {
    const z = zip('gmapsupp.img', data);
    const heard: Array<[number, number]> = [];
    const e = await firstEntry(chunked(z, 1000), (n, of) => heard.push([n, of]));
    expect([e.name, e.size]).toEqual(['gmapsupp.img', data.length]);
    expect(await all(e.stream)).toEqual(data);
    expect(heard.at(-1)).toEqual([e.packedSize, e.packedSize]);
  });

  test('a stored (unpacked) entry, in one chunk', async () => {
    const e = await firstEntry(chunked(zip('a.img', data, { method: 0 }), 1 << 20));
    expect(await all(e.stream)).toEqual(data);
  });

  test('refuses what it cannot read, in plain words', async () => {
    await expect(firstEntry(chunked(new TextEncoder().encode('<html>Not found</html> and more text'), 10))).rejects.toThrow('not a zip file');
    await expect(firstEntry(chunked(zip('a.img', data, { flags: 0x08 }), 1000))).rejects.toThrow('sizes up front');
    await expect(firstEntry(chunked(zip('a.img', data, { method: 12 }), 1000))).rejects.toThrow(ZipError);
  });

  test('a download that stops early fails rather than giving a short file', async () => {
    const z = zip('a.img', data);
    const e = await firstEntry(chunked(z.slice(0, 20_000), 500));
    expect(e.packedSize).toBeGreaterThan(20_000);
    await expect(all(e.stream)).rejects.toThrow('ended early');
  });
});
