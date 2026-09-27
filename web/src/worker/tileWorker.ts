/// <reference lib="webworker" />
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';
import { buildTile, SubdivisionCache } from '../tiles/buildTile';

declare const self: DedicatedWorkerGlobalScope;

let opened: Promise<GarminMap> | null = null;
const cache = new SubdivisionCache(1500);

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const m = await opened;
      self.postMessage({ type: 'opened', id: msg.id, bounds: m.bounds, typ: m.typ, tileIds: m.tiles.map((t) => t.id) });
    } else if (msg.type === 'tile') {
      if (!opened) throw new Error('map not opened');
      const m = await opened;
      const t0 = performance.now();
      const r = await buildTile(m, cache, msg.z, msg.x, msg.y);
      const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
      self.postMessage({ type: 'tile', id: msg.id, data: buf, ms: performance.now() - t0, badSections: r.badSections, features: r.features }, [buf]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
