import * as maplibregl from 'maplibre-gl';
import { emptyTyp, parseTyp, type Typ } from '../img/typ';
import type { RoadClasses } from '../routing/roadClass';
import { collapseNearby, describePlace, titleCase, townsOf } from '../search/describe';
import { PlaceIndex } from '../search/placeIndex';
import type { Place } from '../search/places';
import { decodePlacesCache, encodePlacesCache } from '../search/placesCache';
import { cacheKey, readText, writeText, type Stored } from '../storage/store';
import { buildStyle, FONT_REGULAR } from '../style/buildStyle';
import { preloadImages } from '../ui/images';
import { versionLabel } from '../buildInfo';
import { PerfStats } from '../ui/perf';
import { browserScreenAwake } from '../location/wakeLock';
import { readSetting, writeSetting } from '../ui/settings';
import { HeightControl, LocationControl } from './location';
import { RoutePlanner } from './route';
import { SavedPanel } from './savedPanel';
import { DriveSync } from './driveSync';
import { loadSession, saveSession } from './session';
import { TracksPanel } from './tracks';
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
      tracks: TracksPanel | null;
      routePlanner: RoutePlanner | null;
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
  // Where the app was last time (iOS may close it in the background or when memory runs short).
  const session = loadSession(stored.meta.imgName);
  const view = session ? { center: session.view.center, zoom: session.view.zoom, bearing: session.view.bearing } : { bounds: [[w, s], [e, n]] as [[number, number], [number, number]] };
  const map = new maplibregl.Map({ container: 'map', style, ...view, maxZoom: 18, attributionControl: false });
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
  if (session) locate.restore(session.location);
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

  // Which map file is loaded (the GPSmap.is package has several variants that look different).
  $('map-file').textContent = stored.meta.imgName.replace(/\.img$/i, '');
  $('map-dem').textContent = stored.hgt.length ? `${stored.hgt.length} elevation file${stored.hgt.length === 1 ? '' : 's'}` : 'No elevation files';
  $('app-version').textContent = versionLabel();
  $('topbar').hidden = false;
  collapsibleSearch(map);
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

  const app = { map, perf, ready: false, placesReady: false, search: (_q: string): Place[] | null => null, samples: SAMPLES, tracks: null as TracksPanel | null, routePlanner: null as RoutePlanner | null, saved: null as SavedPanel | null, sync: null as DriveSync | null };
  window.__app = app;
  // F-road/track classes from the place-index pass, keyed by tile id and NET offset. Resolved
  // once `loadPlaces` finishes; a route requested before then awaits this instead. Rejected if
  // `loadPlaces` fails, so a route requested with no road index shows a message instead of
  // "Preparing roads…" forever.
  let resolveRoads: (roads: RoadClasses) => void;
  let rejectRoads: (err: Error) => void;
  const roadsReady = new Promise<RoadClasses>((res, rej) => {
    resolveRoads = res;
    rejectRoads = rej;
  });
  roadsReady.catch(() => {}); // avoid an unhandled-rejection warning when no route is ever requested
  map.once('idle', () => (app.ready = true));
  // GPX tracks: drawn above the map once its style has loaded; ⋯ → Tracks lists and imports them.
  // The route planner is built after it so its route line draws above GPX tracks.
  // Remember the view, location mode and route card as they change, and when the app is hidden.
  let rememberTimer = 0;
  const saveNow = () => {
    clearTimeout(rememberTimer);
    if (closed) return;
    const c = map.getCenter();
    saveSession({
      map: stored.meta.imgName,
      view: { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing() },
      location: locate.current,
      route: app.routePlanner ? app.routePlanner.snapshot() : session?.route ?? null,
    });
  };
  const remember = () => {
    clearTimeout(rememberTimer);
    rememberTimer = window.setTimeout(saveNow, 500);
  };
  map.on('moveend', remember);
  locate.onStateChange = remember;
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow());
  window.addEventListener('pagehide', saveNow);

  map.once('load', () => {
    const tracks = new TracksPanel(map, (coords) => pool.elevations(coords), FONT_REGULAR);
    app.tracks = tracks;
    $('tracks-open').onclick = () => {
      setMenu(false);
      tracks.show(true);
    };
    const routePlanner = new RoutePlanner(
      map,
      (from, to, allow, prefer) => roadsReady.then((roads) => pool.route(from, to, allow, prefer, roads)),
      searchFrom,
      () => locate.activate(),
    );
    app.routePlanner = routePlanner;
    if (session?.route) routePlanner.restore(session.route);
    routePlanner.onChange = remember;
    locate.onSpeed = (mps) => routePlanner.moving(mps);
    // Saved pins (stars on the map) and routes, from the route card's Save.
    const saved = new SavedPanel(
      map,
      FONT_REGULAR,
      (p) => {
        routePlanner.pick({ name: p.name, lon: p.lon, lat: p.lat, saved: true });
        map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 });
      },
      (r) => routePlanner.openSaved(r),
      () => tracks.reload(),
    );
    app.saved = saved;
    // Google Drive sync of the saved items and tracks (offered when the app has a Google client ID).
    const sync = new DriveSync(async () => {
      await saved.reload();
      await tracks.reload();
    });
    saved.onChanged = tracks.onChanged = () => sync.schedule();
    app.sync = sync;
    routePlanner.onSave = (item) => saved.add(item);
    $('saved-open').onclick = () => {
      setMenu(false);
      saved.show(true);
    };
  });

  void loadPlaces(stored, pool)
    .then(({ index, roads }) => {
      if (closed) return;
      resolveRoads(roads);
      app.search = (q) => index.search(q);
      app.placesReady = true;
      wireSearch(map, index, searchFrom, (d) => app.routePlanner?.pick(d), () => app.routePlanner?.clear());
      const input = $<HTMLInputElement>('search');
      input.placeholder = 'Search places';
      input.disabled = false;
    })
    .catch((err) => {
      if (closed) return; // "Load another map" disposed the pool mid-build
      console.error('search index', err);
      $<HTMLInputElement>('search').placeholder = 'Search unavailable';
      rejectRoads(new Error("Routing is unavailable: the map index couldn't be built."));
    });
}

async function loadPlaces(stored: Stored, pool: TilePool): Promise<{ index: PlaceIndex; roads: RoadClasses }> {
  const key = cacheKey(stored.meta);
  const cached = await readText('places.json').catch(() => null);
  if (cached) {
    const decoded = decodePlacesCache(cached, key);
    if (decoded) return { index: new PlaceIndex(decoded.places), roads: decoded.roads };
  }
  const { places, roads } = await pool.places();
  // A failed cache write only costs a rebuild next launch; search still works now.
  await writeText('places.json', encodePlacesCache(key, places, roads)).catch((err) => console.warn('places cache', err));
  return { index: new PlaceIndex(places), roads };
}

function wireSearch(
  map: maplibregl.Map,
  index: PlaceIndex,
  searchFrom: () => { at: [number, number]; gps: boolean },
  onPick: (dest: { name: string | null; lon: number; lat: number }) => void,
  onClear: () => void,
): void {
  const towns = townsOf(index.places);
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('results');
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
          onPick({ name: titleCase(p.name), lon: p.lon, lat: p.lat });
          list.replaceChildren();
          input.blur();
        };
        return li;
      }),
    );
  };
  const clear = $<HTMLButtonElement>('search-clear');
  // While the box is focused and empty: how to pick a place that search can't find.
  const hint = $('search-hint');
  hint.textContent = matchMedia('(pointer: coarse)').matches ? 'Press and hold on the map to pick any place' : 'Right-click the map (Ctrl+Click on a Mac) to pick any place';
  const syncHint = () => (hint.hidden = !(document.activeElement === input && input.value === ''));
  input.addEventListener('focus', syncHint);
  input.addEventListener('blur', syncHint);
  syncHint();
  input.addEventListener('input', () => {
    syncHint();
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
    onClear();
    input.focus();
    syncHint();
  };
}

/** The search bar is a magnifier until tapped; it collapses again when left empty (focus moves
 *  elsewhere, or the map is touched, which on iOS doesn't take focus from the input by itself). */
function collapsibleSearch(map: maplibregl.Map): void {
  const bar = $('topbar');
  const input = $<HTMLInputElement>('search');
  const collapse = () => {
    if (input.value === '' && document.activeElement !== input) bar.classList.add('collapsed');
  };
  $('search-open').onclick = () => {
    bar.classList.remove('collapsed');
    input.focus(); // in the tap itself, so iOS shows the keyboard
  };
  input.addEventListener('blur', () => setTimeout(collapse, 0));
  map.getCanvasContainer().addEventListener('pointerdown', () => {
    input.blur();
    collapse();
  });
}
