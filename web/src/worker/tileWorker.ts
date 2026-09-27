/// <reference lib="webworker" />
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';
import { buildTile, SubdivisionCache } from '../tiles/buildTile';

declare const self: DedicatedWorkerGlobalScope;

let opened: Promise<GarminMap> | null = null;
const cache = new SubdivisionCache();
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
      // A new file shares no subdivisions with whatever was cached for the last one.
      cache.clear();
      cancelled.clear();
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const m = await opened;
      self.postMessage({ type: 'opened', id: msg.id, bounds: m.bounds, typ: m.typ, tileIds: m.tiles.map((t) => t.id) });
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
    }
  } catch (err) {
    if (cancelled.delete(msg.id)) return;
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
