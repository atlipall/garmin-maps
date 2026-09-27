import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { emptyTyp, parseTyp, type Typ } from './img/typ';
import { buildStyle } from './style/buildStyle';
import { preloadImages } from './ui/images';
import { PerfStats } from './ui/perf';
import { TilePool } from './worker/pool';

/** MapLibre zooms, i.e. one less than the raster samples' zoom, so the scale matches. */
const SAMPLES: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: 'reykjavik-z14', center: [-21.94, 64.146], zoom: 14 },
  { name: 'landmannalaugar-z12', center: [-19.06, 63.99], zoom: 12 },
  { name: 'vatnajokull-z10', center: [-16.9, 64.02], zoom: 10 },
  { name: 'iceland-z6', center: [-18.6, 64.9], zoom: 6 },
];

declare global {
  interface Window {
    __app?: { map: maplibregl.Map; perf: PerfStats; ready: boolean; samples: typeof SAMPLES };
  }
}

const $ = (id: string) => document.getElementById(id)!;

/** Touch devices tend to have many cores but weaker per-core performance and tighter memory, so
 *  they get a small fixed worker count; other devices scale with `hardwareConcurrency` (leaving
 *  one core for the main thread, capped so we don't over-subscribe). */
function tileWorkerCount(): number {
  if (navigator.maxTouchPoints > 0) return 2;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
}

async function start(file: File): Promise<void> {
  const pool = new TilePool(file, tileWorkerCount());
  const meta = await pool.open();
  const perf = new PerfStats($('perf'));
  maplibregl.addProtocol('garmin', async (params, abortController) => {
    const m = /^garmin:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`bad tile url ${params.url}`);
    const r = await pool.tile(Number(m[1]), Number(m[2]), Number(m[3]), abortController.signal);
    perf.record(r.ms, r.badSections, r.features);
    return { data: r.data };
  });
  let typ: Typ;
  try {
    typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  } catch (err) {
    console.warn('failed to parse TYP style file, falling back to default styling', err);
    typ = emptyTyp();
  }
  const glyphs = new URL('fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  const { style, images } = buildStyle(typ, { tiles: 'garmin://{z}/{x}/{y}', glyphs });
  const [w, s, e, n] = meta.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[w, s], [e, n]], maxZoom: 18 });
  // Register every icon/pattern before any tile is fetched, so the first tile that references
  // one already finds it (see preloadImages for why the lazy styleimagemissing path alone isn't
  // enough). The styleimagemissing handler stays as a defensive fallback in case `images` is
  // ever incomplete for a type the style still references.
  preloadImages(map, images);
  map.on('styleimagemissing', (ev) => {
    const img = images.get(ev.id);
    if (img && !map.hasImage(ev.id)) map.addImage(ev.id, img);
  });
  map.on('error', (ev) => console.error(ev.error));
  for (const sample of SAMPLES) {
    const b = document.createElement('button');
    b.textContent = sample.name;
    b.onclick = () => map.jumpTo({ center: sample.center, zoom: sample.zoom });
    $('jumps').append(b);
  }
  window.__app = { map, perf, ready: false, samples: SAMPLES };
  map.once('idle', () => (window.__app!.ready = true));
}

($('file') as HTMLInputElement).addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  $('error').textContent = '';
  try {
    await start(file);
  } catch (err) {
    $('error').textContent = err instanceof Error ? err.message : String(err);
  }
});
