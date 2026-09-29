import * as maplibregl from 'maplibre-gl';
import type { Kind } from '../img/rgn';
import { emptyTyp, parseTyp, type Typ } from '../img/typ';
import { collapseNearby, describePlace, titleCase, townsOf } from '../search/describe';
import { PlaceIndex } from '../search/placeIndex';
import type { Place } from '../search/places';
import { cacheKey, readText, writeText, type Stored } from '../storage/store';
import { buildStyle } from '../style/buildStyle';
import { preloadImages } from '../ui/images';
import { PerfStats } from '../ui/perf';
import { browserScreenAwake } from '../location/wakeLock';
import { HeightControl, LocationControl } from './location';
import { TilePool, type OpenMeta } from '../worker/pool';
import { showImport } from './importScreen';

/** MapLibre zooms, i.e. one less than the raster samples' zoom, so the scale matches. */
const SAMPLES: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: 'reykjavik-z14', center: [-21.94, 64.146], zoom: 14 },
  { name: 'landmannalaugar-z12', center: [-19.06, 63.99], zoom: 12 },
  { name: 'vatnajokull-z10', center: [-16.9, 64.02], zoom: 10 },
  { name: 'iceland-z6', center: [-18.6, 64.9], zoom: 6 },
];

declare global {
  interface Window {
    __app?: {
      map: maplibregl.Map;
      perf: PerfStats;
      ready: boolean;
      placesReady: boolean;
      search: (q: string) => Place[] | null;
      samples: typeof SAMPLES;
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const parseZxy = (url: string) => {
  const m = /^[a-z]+:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) throw new Error(`bad tile url ${url}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};

/** Touch devices tend to have many cores but weaker per-core performance and tighter memory, so
 *  they get a small fixed worker count; other devices scale with `hardwareConcurrency` (leaving
 *  one core for the main thread, capped so we don't over-subscribe). */
function tileWorkerCount(): number {
  if (navigator.maxTouchPoints > 0) return 2;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
}

export async function startViewer(stored: Stored): Promise<void> {
  const pool = new TilePool({ file: stored.img, hgt: stored.hgt, overview: stored.overview }, tileWorkerCount());
  let meta: OpenMeta;
  try {
    meta = await pool.open();
  } catch (err) {
    pool.dispose();
    throw err;
  }
  try {
    mountViewer(stored, pool, meta);
  } catch (err) {
    // e.g. no WebGL: don't leave tile workers (holding the map file) running behind the error.
    pool.dispose();
    throw err;
  }
}

function mountViewer(stored: Stored, pool: TilePool, meta: OpenMeta): void {
  const debug = new URLSearchParams(location.search).has('debug');
  const perf = new PerfStats($('perf'));
  $('perf').hidden = !debug;
  let bad = 0;

  maplibregl.addProtocol('garmin', async (params, abortController) => {
    const r = await pool.tile(...parseZxy(params.url), abortController.signal);
    perf.record(r.ms, r.badSections, r.features);
    if (r.badSections) {
      bad += r.badSections;
      $('badge').hidden = false;
      $('badge').textContent = `⚠ ${bad} map section${bad === 1 ? '' : 's'} could not be decoded`;
    }
    return { data: r.data };
  });
  if (meta.demBounds) {
    maplibregl.addProtocol('dem', async (params, abortController) => {
      const r = await pool.dem(...parseZxy(params.url), abortController.signal);
      if (r.bitmap) return { data: r.bitmap };
      if (r.rgba) return { data: await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba), 256, 256)) };
      throw new Error(`empty DEM tile ${params.url}`);
    });
  }

  let typ: Typ;
  try {
    typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  } catch (err) {
    console.warn('failed to parse TYP style file, falling back to default styling', err);
    typ = emptyTyp();
  }
  const glyphs = new URL('fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  const { style, images } = buildStyle(typ, {
    tiles: 'garmin://{z}/{x}/{y}',
    glyphs,
    ...(meta.demBounds ? { dem: 'dem://{z}/{x}/{y}', demBounds: meta.demBounds } : {}),
  });
  const [w, s, e, n] = meta.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[w, s], [e, n]], maxZoom: 18, attributionControl: false });
  // Register every icon/pattern before any tile is fetched (see src/ui/images.ts); the
  // styleimagemissing handler stays as a defensive fallback.
  preloadImages(map, images);
  map.on('styleimagemissing', (ev) => {
    const img = images.get(ev.id);
    if (img && !map.hasImage(ev.id)) map.addImage(ev.id, img);
  });
  map.on('error', (ev) => console.error(ev.error));
  // Phones pinch to zoom, so they get only the compass; the locate button sits bottom-right,
  // within thumb reach.
  const touch = matchMedia('(pointer: coarse)').matches;
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: !touch }), 'top-right');
  // Locate button (bottom-right): follow with north up / heading up, direction cone, ground height.
  const height = new HeightControl();
  const locate = new LocationControl((lon, lat) => pool.elevation(lon, lat), height.element);
  map.addControl(locate, 'bottom-right');
  // Keep the screen on while location is on (a ⋯ menu switch, remembered on this device).
  const awake = browserScreenAwake();
  let keepAwake = readSetting('keepAwake', true);
  let locating = false;
  const keepAwakeItem = $<HTMLButtonElement>('keep-awake');
  const syncAwake = () => {
    keepAwakeItem.setAttribute('aria-checked', String(keepAwake));
    awake.setWanted(keepAwake && locating);
  };
  keepAwakeItem.hidden = !awake.supported;
  keepAwakeItem.onclick = () => {
    keepAwake = !keepAwake;
    writeSetting('keepAwake', keepAwake);
    syncAwake();
  };
  locate.onActiveChange = (active) => {
    locating = active;
    syncAwake();
  };
  syncAwake();
  // Corner controls stack upwards in the order added: the height pill sits above the scale bar.
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(height, 'bottom-left');
  // The last GPS fix is the reference for search-result distances (the map centre when none is recent).
  const searchFrom = (): { at: [number, number]; gps: boolean } => {
    const fix = locate.lastFix;
    if (fix && Date.now() - fix.time < 10 * 60_000) return { at: fix.at, gps: true };
    const c = map.getCenter();
    return { at: [c.lng, c.lat], gps: false };
  };

  $('topbar').hidden = false;
  $('menu-button').hidden = false;
  const setMenu = (open: boolean) => {
    $('menu').hidden = !open;
    $('menu-button').setAttribute('aria-expanded', String(open));
  };
  $('menu-button').onclick = () => setMenu($('menu').hidden !== false);
  map.on('movestart', () => setMenu(false));
  let closed = false;
  $('replace').onclick = () => {
    // Nothing is deleted here: the stored map stays until a new import commits (and Cancel
    // reloads straight back into it). Stop the workers and the map to free memory for the import.
    closed = true;
    setMenu(false);
    pool.dispose();
    map.remove();
    for (const id of ['topbar', 'menu-button', 'badge', 'perf']) $(id).hidden = true;
    showImport('', { hasMap: true, canCancel: true });
  };

  const app = { map, perf, ready: false, placesReady: false, search: (_q: string): Place[] | null => null, samples: SAMPLES };
  window.__app = app;
  map.once('idle', () => (app.ready = true));

  void loadPlaces(stored, pool)
    .then((index) => {
      if (closed) return;
      app.search = (q) => index.search(q);
      app.placesReady = true;
      wireSearch(map, index, searchFrom);
      const input = $<HTMLInputElement>('search');
      input.placeholder = 'Search places';
      input.disabled = false;
    })
    .catch((err) => {
      if (closed) return; // "Load another map" disposed the pool mid-build
      console.error('search index', err);
      $<HTMLInputElement>('search').placeholder = 'Search unavailable';
    });
}

/** Compact on-disk form of a `Place`: [name, lon, lat, kindCode, type]. */
type PackedPlace = [string, number, number, number, number];
const KINDS: Kind[] = ['point', 'line', 'polygon'];
const PLACES_VERSION = 1;

async function loadPlaces(stored: Stored, pool: TilePool): Promise<PlaceIndex> {
  const key = cacheKey(stored.meta);
  const cached = await readText('places.json').catch(() => null);
  if (cached) {
    const places = decodePlaces(cached, key);
    if (places) return new PlaceIndex(places);
  }
  const places = await pool.places();
  const packed: PackedPlace[] = places.map((p) => [p.name, p.lon, p.lat, KINDS.indexOf(p.kind), p.type]);
  // A failed cache write only costs a rebuild next launch; search still works now.
  await writeText('places.json', JSON.stringify({ key, v: PLACES_VERSION, places: packed })).catch((err) => console.warn('places cache', err));
  return new PlaceIndex(places);
}

/** Returns null (a cache miss) for another map's cache, an old/unknown format, or corrupt JSON. */
function decodePlaces(text: string, key: string): Place[] | null {
  try {
    const parsed = JSON.parse(text) as { key?: unknown; v?: unknown; places?: unknown };
    if (parsed.key !== key || parsed.v !== PLACES_VERSION || !Array.isArray(parsed.places)) return null;
    const out: Place[] = [];
    for (const row of parsed.places as unknown[]) {
      if (!Array.isArray(row) || row.length !== 5) return null;
      const [name, lon, lat, kindCode, type] = row as PackedPlace;
      const kind = KINDS[kindCode];
      if (typeof name !== 'string' || typeof lon !== 'number' || typeof lat !== 'number' || !kind || typeof type !== 'number') return null;
      out.push({ name, lon, lat, kind, type });
    }
    return out;
  } catch {
    return null;
  }
}

function wireSearch(map: maplibregl.Map, index: PlaceIndex, searchFrom: () => { at: [number, number]; gps: boolean }): void {
  const towns = townsOf(index.places);
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('results');
  let marker: maplibregl.Marker | null = null;
  let timer = 0;
  const render = () => {
    list.replaceChildren(
      ...collapseNearby(index.search(input.value, 100, searchFrom().at)).slice(0, 20).map((p) => {
        const from = searchFrom();
        const d = describePlace(p, towns, from.at);
        const li = document.createElement('li');
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = titleCase(p.name);
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = [d.category, d.where].filter(Boolean).join(' · ');
        const dist = document.createElement('span');
        dist.className = 'dist';
        dist.textContent = d.distance ?? '';
        dist.title = from.gps ? 'from your position' : 'from the map centre';
        li.append(name, detail, dist);
        li.onclick = () => {
          map.flyTo({ center: [p.lon, p.lat], zoom: p.kind === 'point' ? 14 : 12 });
          marker?.remove();
          marker = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([p.lon, p.lat]).addTo(map);
          list.replaceChildren();
          input.blur();
        };
        return li;
      }),
    );
  };
  const clear = $<HTMLButtonElement>('search-clear');
  input.addEventListener('input', () => {
    clear.hidden = input.value === '';
    clearTimeout(timer);
    timer = window.setTimeout(render, 120);
  });
  // Clear the query, results and result pin, but keep the keyboard up for a new search.
  clear.addEventListener('pointerdown', (ev) => ev.preventDefault()); // don't steal focus from the input
  clear.onclick = () => {
    clearTimeout(timer);
    input.value = '';
    clear.hidden = true;
    list.replaceChildren();
    marker?.remove();
    marker = null;
    input.focus();
  };
}

/** Per-device preferences in localStorage; storage can be unavailable (private mode), so both
 *  sides fail soft to the default. */
function readSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // not remembered; the switch still works for this session
  }
}
