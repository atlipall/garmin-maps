/**
 * The first file in a zip, unpacked while it downloads: the map arrives as a 255 MB zip and the
 * phone can't hold it in memory, so the file's bytes stream through the browser's own inflater
 * (DecompressionStream) straight to storage. Reads the entry's local header only, so the entry must
 * give its sizes there (no data descriptor, no zip64): true of zips made by the usual tools for a
 * single file under 4 GB, Freizeitkarte's included.
 */

export interface ZipEntry {
  name: string;
  /** Unpacked size. */
  size: number;
  /** Packed size: the bytes read from the zip for this entry. */
  packedSize: number;
  /** The unpacked bytes. */
  stream: ReadableStream<Uint8Array>;
}

const LOCAL_HEADER = 0x04034b50;
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export class ZipError extends Error {}

/** Opens the zip's first entry. `onPacked` hears how many of its packed bytes have been read, of how
 *  many (it may be called before this returns: the inflater starts reading straight away). */
export async function firstEntry(zip: ReadableStream<Uint8Array>, onPacked?: (bytes: number, of: number) => void): Promise<ZipEntry> {
  const reader = zip.getReader();
  let buf = new Uint8Array(0);
  const fill = async (n: number) => {
    while (buf.length < n) {
      const { done, value } = await reader.read();
      if (done) throw new ZipError('The download ended early.');
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  };
  try {
    await fill(30);
    if (u32(buf, 0) !== LOCAL_HEADER) throw new ZipError('The download is not a zip file.');
    const flags = u16(buf, 6);
    const method = u16(buf, 8);
    const packedSize = u32(buf, 18);
    const size = u32(buf, 22);
    const nameLen = u16(buf, 26);
    const start = 30 + nameLen + u16(buf, 28);
    if (flags & 0x08 || packedSize === 0xffffffff || size === 0xffffffff) throw new ZipError('The zip file does not give its sizes up front.');
    if (flags & 0x01) throw new ZipError('The zip file is encrypted.');
    if (method !== 0 && method !== 8) throw new ZipError(`The zip file is packed in a way this app can't unpack (method ${method}).`);
    await fill(start);
    const name = new TextDecoder().decode(buf.subarray(30, 30 + nameLen));
    let rest: Uint8Array | null = buf.subarray(start);
    let read = 0;
    // Exactly the entry's packed bytes: the zip's directory follows them, and the inflater
    // refuses anything after the end of its data.
    const packed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Uint8Array;
        if (rest) {
          chunk = rest;
          rest = null;
        } else {
          const { done, value } = await reader.read();
          if (done) {
            controller.error(new ZipError('The download ended early.'));
            return;
          }
          chunk = value;
        }
        const take = Math.min(chunk.length, packedSize - read);
        if (take > 0) controller.enqueue(chunk.subarray(0, take));
        read += take;
        onPacked?.(read, packedSize);
        if (read >= packedSize) {
          controller.close();
          void reader.cancel().catch(() => {});
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    const stream = method === 8 ? packed.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>) : packed;
    return { name, size, packedSize, stream };
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
}
