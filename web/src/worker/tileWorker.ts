/// <reference lib="webworker" />
import { Dem, TILE_SIZE } from '../dem/dem';
import { decodeOverview } from '../dem/overview';
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';
import { collectPlaces } from '../search/places';
import { buildTile, SubdivisionCache } from '../tiles/buildTile';

declare const self: DedicatedWorkerGlobalScope;

let opened: Promise<GarminMap> | null = null;
/** Set synchronously when `open` arrives, so a `dem` request that lands while `open` is still
 *  building the DEM (e.g. right after the pool respawned this worker) waits instead of failing. */
let demReady: Promise<Dem | null> | null = null;
// 750k points: the coarsest level alone needs ~585k for a 3x3 block of z7 tiles, plus the slim
// early-road and label-context entries.
const cache = new SubdivisionCache(750_000);
/** Ids of `tile` requests the pool has asked us to abandon. Checked before starting decode work
 *  and again right before posting a result, so a cancelled tile does as little wasted work as
 *  practical; entries are removed once consumed so the set can't grow without bound. */
const cancelled = new Set<number>();

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  try {
    if (msg.type === 'open') {
      // A new file shares no subdivisions with whatever was cached for the last one, and no DEM
      // data either (a map with no .hgt files must not keep serving the previous map's terrain).
      cache.clear();
      cancelled.clear();
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const hgt = (msg.hgt ?? []) as File[];
      const overviewFile = (msg.overview ?? null) as File | null;
      demReady = hgt.length
        ? (async () => {
            const overview = overviewFile ? decodeOverview(new Uint8Array(await overviewFile.arrayBuffer())) : null;
            return Dem.fromFiles(hgt.map((f) => ({ name: f.name, src: new BlobSource(f) })), overview);
          })()
        : Promise.resolve(null);
      demReady.catch(() => {}); // surfaced by the awaits below / in `dem`; never an unhandled rejection
      const m = await opened;
      const dem = await demReady;
      self.postMessage({
        type: 'opened',
        id: msg.id,
        bounds: m.bounds,
        typ: m.typ,
        tileIds: m.tiles.map((t) => t.id),
        demBounds: dem?.bounds ?? null,
      });
    } else if (msg.type === 'tile') {
      if (!opened) throw new Error('map not opened');
      if (cancelled.delete(msg.id)) return;
      const m = await opened;
      if (cancelled.delete(msg.id)) return;
      const t0 = performance.now();
      const r = await buildTile(m, cache, msg.z, msg.x, msg.y);
      if (cancelled.delete(msg.id)) return;
      const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
      self.postMessage({ type: 'tile', id: msg.id, data: buf, ms: performance.now() - t0, badSections: r.badSections, features: r.features }, [buf]);
    } else if (msg.type === 'dem') {
      if (!demReady) throw new Error('map not opened');
      const dem = await demReady;
      if (!dem) throw new Error('no elevation data loaded');
      if (cancelled.delete(msg.id)) return;
      const t0 = performance.now();
      const rgba = await dem.tile(msg.z, msg.x, msg.y);
      if (cancelled.delete(msg.id)) return;
      // createImageBitmap is missing or throws on some older iOS Safari versions; fall back to
      // shipping the raw RGBA buffer so the main thread (Task 6) can build the bitmap itself.
      let bitmap: ImageBitmap | undefined;
      if (typeof createImageBitmap === 'function') {
        try {
          // Dem.tile()'s Uint8ClampedArray is generic over ArrayBufferLike; ImageData wants the
          // narrower ArrayBuffer, which is what a freshly allocated typed array is backed by.
          bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, TILE_SIZE, TILE_SIZE));
        } catch {
          bitmap = undefined;
        }
      }
      const ms = performance.now() - t0;
      if (cancelled.delete(msg.id)) return;
      if (bitmap) {
        self.postMessage({ type: 'dem', id: msg.id, bitmap, ms }, [bitmap]);
      } else {
        const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
        self.postMessage({ type: 'dem', id: msg.id, rgba: buf, ms }, [buf]);
      }
    } else if (msg.type === 'places') {
      if (!opened) throw new Error('map not opened');
      if (cancelled.delete(msg.id)) return;
      const m = await opened;
      // collectPlaces (and the decodeAll it's built on) has no way to abort mid-decode short of
      // changing its signature, which is out of scope here — this only skips starting the work,
      // or skips replying, for a request that's already been cancelled either side of it.
      const places = await collectPlaces(m);
      if (cancelled.delete(msg.id)) return;
      self.postMessage({ type: 'places', id: msg.id, places });
    }
  } catch (err) {
    if (cancelled.delete(msg.id)) return;
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
