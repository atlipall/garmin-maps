import * as maplibregl from 'maplibre-gl';
import type { RouteReply } from '../worker/pool';
import { readSetting, writeSetting } from '../ui/settings';
import { offRoadText, routeMessage, type StartKind } from './routeMessage';
import type { Place, SessionRoute } from './session';
import { titleCase } from '../search/describe';
import { FONT_REGULAR } from '../style/buildStyle';
import type { LonLat } from '../routing/plan';
import { bestInsert, joinLegs, type JoinedRoute } from '../routing/waypoints';
import { newId, type RouteOk, type Saved, type SavedRoute } from '../saved/saved';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Hold time for a long press: below iOS's own ~0.5 s long-press gestures (selection loupe, callout). */
const LONG_PRESS_MS = 450;
/** iOS may cancel the touch when its own long-press gesture starts; a finger held still this long
 *  by then already counts as a long press. */
const LONG_PRESS_CANCEL_MS = 350;
/** "Use my location" gives up on a first fix after this long. */
const FIX_WAIT_MS = 20_000;
/** Moving faster than this (m/s, about 9 km/h: faster than walking) minimizes the route card. */
const MOVING_MPS = 2.5;

export const fmtKm = (m: number) => (m < 10_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);
export function fmtTime(s: number): string {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const coordsText = (p: { lon: number; lat: number }) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

const FROM_TEXT: Record<StartKind, string> = { gps: 'your position', centre: 'the map centre', chosen: 'the chosen point' };

/** A white pin with a dark outline for a start chosen on the map. */
function startPinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'start-pin';
  el.innerHTML = '<svg viewBox="0 0 27 41" width="27" height="41" aria-hidden="true"><path d="M13.5 1.5C6.9 1.5 1.5 6.9 1.5 13.5c0 9 12 26 12 26s12-17 12-26c0-6.6-5.4-12-12-12z" fill="#fff" stroke="#1d3f8f" stroke-width="2.5"/><circle cx="13.5" cy="13.5" r="4.5" fill="#1d3f8f"/></svg>';
  el.title = 'Route start';
  return el;
}

/** Destination card, route panel and route line (route planning without guidance). */
export class RoutePlanner {
  private pin: maplibregl.Marker | null = null;
  private dest: Place | null = null;
  /** Waypoints between the start and the destination, in route order. */
  private vias: Place[] = [];
  /** A start chosen on the map; null: your position or the map centre. */
  private start: [number, number] | null = null;
  private startPin: maplibregl.Marker | null = null;
  /** The next plain map tap sets the start. */
  private choosing = false;
  private allow = readSetting('allowFRoads', true);
  private prefer = readSetting('preferFRoads', false);
  private started = false;
  /** A route line is on the map. */
  private shown = false;
  /** A route is being planned (reset when it's superseded or cleared). */
  private planning = false;
  /** A question in the card ("clear the current route?", "add as a waypoint?"): what its buttons do,
   *  and the grey marker of the new place it's about (none when it's the × asking). */
  private pending: { yes: () => void; via: (() => void) | null; marker: maplibregl.Marker | null } | null = null;
  /** "Use my location" is waiting for a first fix (a switch change keeps waiting). */
  private waiting = false;
  private seq = 0;
  /** The route start when it was the map centre (remembered as a point across restarts). */
  private fromCentre: [number, number] | null = null;
  /** The next route found moves the map to show it (not a route restored at startup). */
  private fitRoute = true;
  /** Called when the place, start or route changes (for remembering them across restarts). */
  onChange: (() => void) | null = null;
  /** The card is shrunk to one line. */
  private minimized = false;
  /** Opened again by hand: not minimized automatically again for this route. */
  private keepOpen = false;
  /** The route on the map and where it started (what "Save" keeps). */
  private last: { route: JoinedRoute; from: [number, number] } | null = null;
  /** The place or route in the card is saved (until the card changes). */
  private saved = false;
  /** Stores a saved pin or route (the Saved panel). */
  onSave: ((item: Saved) => Promise<void>) | null = null;

  /** `searchFrom`: your recent GPS position, else the map centre. `useLocation` turns location on. */
  constructor(
    private readonly map: maplibregl.Map,
    private readonly plan: (from: [number, number], to: [number, number], allow: boolean, prefer: boolean) => Promise<RouteReply>,
    private readonly searchFrom: () => { at: [number, number]; gps: boolean },
    private readonly useLocation: () => void,
  ) {
    map.addSource('route', { type: 'geojson', data: EMPTY });
    const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: kind('route'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 15, 11] } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: kind('route'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 15, 7] } });
    // Straight legs between a chosen point and its road: thinner and dashed.
    map.addLayer({ id: 'route-offroad', type: 'line', source: 'route', filter: kind('offroad'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 15, 4], 'line-dasharray': [2, 1.5] } });
    // The start of the route: a white dot with a dark outline.
    map.addLayer({ id: 'route-start', type: 'circle', source: 'route', filter: kind('start'), paint: { 'circle-color': '#ffffff', 'circle-radius': 6, 'circle-stroke-color': '#1d3f8f', 'circle-stroke-width': 3 } });
    // Waypoints: numbered dark-blue circles (a tap offers to remove one).
    map.addSource('route-vias', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'route-via', type: 'circle', source: 'route-vias', paint: { 'circle-color': '#1d3f8f', 'circle-radius': 10, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'route-via-number', type: 'symbol', source: 'route-vias', layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': [FONT_REGULAR], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
    $<HTMLInputElement>('route-froads').checked = this.allow;
    $('route-go').onclick = () => void this.route();
    // With a route on the map (or on its way), × asks first; a card with just a place closes.
    $('route-close').onclick = () => {
      if (this.shown || this.planning) this.ask('Clear the current route?', null, () => this.clear());
      else this.clear();
    };
    $('route-min').onclick = (e) => {
      e.stopPropagation();
      this.setMinimized(!this.minimized, true);
    };
    $('route-card').addEventListener('click', () => {
      if (this.minimized) this.setMinimized(false, true);
    });
    $('route-confirm-yes').onclick = () => {
      const yes = this.pending?.yes;
      this.dropPending();
      yes?.();
    };
    $('route-confirm-via').onclick = () => {
      const via = this.pending?.via;
      this.dropPending();
      via?.();
    };
    $('route-confirm-no').onclick = () => this.dropPending();
    $<HTMLInputElement>('route-prefer').checked = this.prefer;
    $<HTMLInputElement>('route-froads').onchange = (e) => {
      this.allow = (e.target as HTMLInputElement).checked;
      writeSetting('allowFRoads', this.allow);
      this.showSwitches();
      // While waiting for a position, the route that follows uses the new setting.
      if (this.started && !this.waiting) void this.route();
    };
    // Prefer F-roads (only offered while they're allowed): they count for less when choosing.
    $<HTMLInputElement>('route-prefer').onchange = (e) => {
      this.prefer = (e.target as HTMLInputElement).checked;
      writeSetting('preferFRoads', this.prefer);
      // While waiting for a position, the route that follows uses the new setting.
      if (this.started && !this.waiting) void this.route();
    };
    $('route-change').onclick = () => this.showChoices($('route-choices').hidden === true);
    $('route-use-gps').onclick = () => void this.useMyLocation();
    $('route-choose').onclick = () => this.chooseOnMap();
    $('route-save').onclick = () => this.showSaveForm(true);
    $('route-save-cancel').onclick = () => this.showSaveForm(false);
    $<HTMLFormElement>('route-save-form').onsubmit = (e) => {
      e.preventDefault();
      void this.save($<HTMLInputElement>('route-save-name').value.trim());
    };
    // Long press (touch) or right-click (mouse) drops a pin with a "Route here" card.
    // A plain tap elsewhere on the map sets the start while choosing one, else closes the card while
    // it only offers "Route here"; a shown route stays until ×. The click a browser may send after a
    // long press or a Ctrl+Click (a Mac's right-click: contextmenu, then click) is ignored.
    let pressed = false;
    map.on('contextmenu', (e) => {
      pressed = true;
      this.pick({ name: null, lon: e.lngLat.lng, lat: e.lngLat.lat, near: this.nameAt(e.point) });
    });
    map.on('click', (e) => {
      // A tap on a waypoint offers to remove it.
      const via = map.getLayer('route-via') ? map.queryRenderedFeatures(e.point, { layers: ['route-via'] })[0] : undefined;
      if (via) {
        const n = Number(via.properties.n);
        this.ask(`Remove waypoint ${n}?`, null, () => this.removeVia(n - 1), { yes: 'Remove', no: 'Keep' });
        return;
      }
      // A tap on a saved star opens its card (the Saved panel handles it).
      if (map.getLayer('saved-pins') && map.queryRenderedFeatures(e.point, { layers: ['saved-pins'] }).length) return;
      if (pressed) pressed = false;
      else if (this.choosing) this.setStart([e.lngLat.lng, e.lngLat.lat]);
      else if (this.dest && !this.started) this.clear();
    });
    let timer = 0;
    let startXY: [number, number] | null = null;
    let startAt = 0;
    const dropAt = (xy: [number, number]) => {
      const r = canvas.getBoundingClientRect();
      const p = new maplibregl.Point(xy[0] - r.left, xy[1] - r.top);
      const ll = map.unproject(p);
      pressed = true;
      this.pick({ name: null, lon: ll.lng, lat: ll.lat, near: this.nameAt(p) });
    };
    const canvas = map.getCanvasContainer();
    // A new mouse press starts afresh (a right-click is followed by no click to clear the guard).
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') pressed = false;
    });
    canvas.addEventListener('touchstart', (e) => {
      clearTimeout(timer);
      pressed = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const xy: [number, number] = [t.clientX, t.clientY];
      startXY = xy;
      startAt = Date.now();
      timer = window.setTimeout(() => {
        timer = 0;
        dropAt(xy);
      }, LONG_PRESS_MS);
    }, { passive: true });
    const cancelPress = () => {
      clearTimeout(timer);
      timer = 0;
      startXY = null;
    };
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (startXY && (e.touches.length !== 1 || Math.hypot(t.clientX - startXY[0], t.clientY - startXY[1]) > 10)) cancelPress();
    }, { passive: true });
    canvas.addEventListener('touchend', cancelPress);
    // iOS cancels the touch when its own long-press gesture begins: if the finger had already been
    // held still for most of a long press, take it as one rather than dropping the press.
    canvas.addEventListener('touchcancel', () => {
      const xy = startXY;
      const held = timer !== 0 && xy !== null && Date.now() - startAt >= LONG_PRESS_CANCEL_MS;
      cancelPress();
      if (held) dropAt(xy!);
    });
  }

  /** Shows the destination card for a place (from search or a long press). */
  pick(dest: Place): void {
    // With a route on the map (or on its way), a new place becomes a waypoint or a new route.
    if (this.shown || this.planning) {
      const marker = new maplibregl.Marker({ color: '#8a8f98' }).setLngLat([dest.lon, dest.lat]).addTo(this.map);
      this.ask(`Add ${dest.name ?? dest.near ?? 'this pin'} to the route as a waypoint, or start a new route?`, marker, () => {
        this.clearRoute();
        this.pick(dest);
      }, { yes: 'New route', no: 'Cancel', via: () => this.addVia(dest) });
      return;
    }
    this.dropPending();
    this.clearRoute();
    this.setVias([]);
    this.keepOpen = false;
    this.saved = false;
    this.setMinimized(false);
    this.dest = dest;
    this.pin?.remove();
    this.pin = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([dest.lon, dest.lat]).addTo(this.map);
    $('route-title').textContent = dest.name ?? `Dropped pin · ${dest.near ?? coordsText(dest)}`;
    this.setInfo('', '', '');
    this.showChoices(false);
    this.showFrom();
    this.showSwitches();
    $('route-go').hidden = false;
    $('route-card').hidden = false;
    this.fitRoute = true;
    this.showSave();
    this.onChange?.();
  }

  /** The card to remember across restarts: the place and, once routed, where from. */
  snapshot(): SessionRoute | null {
    if (!this.dest) return null;
    return { dest: this.dest, routed: this.started, from: this.start ?? this.fromCentre, vias: this.vias };
  }

  /** Brings back a remembered card; a route is planned again without moving the map. */
  restore(r: SessionRoute): void {
    this.pick(r.dest);
    if (!r.routed) return;
    this.setVias(r.vias ?? []);
    this.fitRoute = false;
    if (r.from) this.setStart(r.from);
    else void this.useMyLocation();
  }

  /** Asks `question` in the card: the `yes` button (label `labels.yes`, "Clear route" by default)
   *  runs `yes`; with `labels.via`, an "Add as waypoint" button first. `marker`: the new place's grey
   *  pin. The `no` button ("Keep route") just closes the question. */
  private ask(question: string, marker: maplibregl.Marker | null, yes: () => void, labels: { yes?: string; no?: string; via?: () => void } = {}): void {
    this.dropPending();
    this.pending = { yes, via: labels.via ?? null, marker };
    $('route-confirm-text').textContent = question;
    $('route-confirm-yes').textContent = labels.yes ?? 'Clear route';
    $('route-confirm-no').textContent = labels.no ?? 'Keep route';
    $('route-confirm-via').hidden = !labels.via;
    $('route-confirm-yes').classList.toggle('primary', !labels.via);
    $('route-confirm').hidden = false;
    $('route-card').hidden = false;
    this.setMinimized(false);
  }

  /** The named map feature at screen point `p`, for naming a dropped pin: the nearest named point
   *  (peak, hut…) within 30 px, else a named line (river, road) within 12 px, else the named area
   *  (lake, glacier…) it's in. Numbers (contour heights, house numbers) don't count. */
  private nameAt(p: maplibregl.Point): string | undefined {
    const named = (f: maplibregl.MapGeoJSONFeature, key: string) => {
      const v = f.properties?.[key];
      if (f.source !== 'garmin' || typeof v !== 'string' || /^[\d\s.,-]+$/.test(v)) return null;
      // Map labels are often in capitals with a height: "HEKLA 1491m" → "Hekla 1491m".
      const m = /^(.*?)(\s+\d+\s?m)?$/.exec(v)!;
      return titleCase(m[1]) + (m[2] ?? '');
    };
    const box = (r: number): [maplibregl.PointLike, maplibregl.PointLike] => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
    let best: { name: string; d: number } | null = null;
    for (const f of this.map.queryRenderedFeatures(box(30))) {
      const name = named(f, 'name');
      if (!name || f.sourceLayer !== 'points' || f.geometry.type !== 'Point') continue;
      const q = this.map.project(f.geometry.coordinates as [number, number]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= 30 && (!best || d < best.d)) best = { name, d };
    }
    if (best) return best.name;
    for (const f of this.map.queryRenderedFeatures(box(12))) {
      const name = f.sourceLayer === 'lines' ? named(f, 'name') : null;
      if (name) return name;
    }
    for (const f of this.map.queryRenderedFeatures(p)) {
      const name = f.sourceLayer === 'polygons' ? named(f, 'n') : null;
      if (name) return name;
    }
    return undefined;
  }

  private setVias(vias: Place[]): void {
    this.vias = vias;
    (this.map.getSource('route-vias') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: vias.map((v, i) => ({ type: 'Feature', properties: { n: i + 1 }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
    });
  }

  /** Adds a waypoint where it adds the least detour, and plans the route again. */
  private addVia(p: Place): void {
    if (!this.dest) return;
    const from = this.start ?? this.last?.from ?? this.searchFrom().at;
    const stops: LonLat[] = [from, ...this.vias.map((v): LonLat => [v.lon, v.lat]), [this.dest.lon, this.dest.lat]];
    const vias = [...this.vias];
    vias.splice(bestInsert(stops, [p.lon, p.lat]), 0, p);
    this.setVias(vias);
    void this.route();
  }

  private removeVia(i: number): void {
    this.setVias(this.vias.filter((_, k) => k !== i));
    void this.route();
  }

  /** Closes the "clear the route?" question and removes its grey marker. */
  private dropPending(): void {
    this.pending?.marker?.remove();
    this.pending = null;
    $('route-confirm').hidden = true;
  }

  clear(): void {
    this.dropPending();
    this.clearRoute();
    this.pin?.remove();
    this.pin = null;
    this.dest = null;
    this.setVias([]);
    this.clearStart();
    $('route-card').hidden = true;
    this.showSave();
    this.keepOpen = false;
    this.setMinimized(false);
    this.onChange?.();
  }

  /** The current speed (m/s, from the GPS): once moving with a route, the card gets out of the way
   *  (unless it was opened again by hand). */
  moving(mps: number): void {
    if (mps < MOVING_MPS || !this.started || this.minimized || this.keepOpen || this.pending || this.choosing || !$('route-choices').hidden) return;
    this.setMinimized(true);
  }

  private setMinimized(min: boolean, byHand = false): void {
    if (byHand && !min) this.keepOpen = true;
    this.minimized = min;
    $('route-card').classList.toggle('min', min);
    const button = $('route-min');
    button.setAttribute('aria-expanded', String(!min));
    button.setAttribute('aria-label', min ? 'Show route details' : 'Minimize');
  }

  private clearRoute(): void {
    this.seq++;
    this.planning = false;
    this.started = false;
    this.choosing = false;
    this.waiting = false;
    this.drawRoute(EMPTY);
  }

  private drawRoute(data: GeoJSON.FeatureCollection): void {
    (this.map.getSource('route') as maplibregl.GeoJSONSource).setData(data);
    this.shown = data.features.length > 0;
    if (!this.shown) this.last = null;
    this.showSave();
  }

  /** "Save" for a place (before routing) or a drawn route; "Saved" once it is. */
  private showSave(): void {
    const button = $<HTMLButtonElement>('route-save');
    button.hidden = !this.dest || (this.started && !this.last);
    button.disabled = this.saved;
    button.textContent = this.saved ? '★ Saved' : '☆ Save';
    if (button.hidden) this.showSaveForm(false);
    // No empty row on a route panel that's still being planned.
    if ($('route-save-form').hidden) $('route-actions').hidden = $('route-go').hidden && button.hidden;
  }

  private showSaveForm(open: boolean): void {
    $('route-save-form').hidden = !open;
    $('route-actions').hidden = open;
    if (!open || !this.dest) return;
    const place = this.dest.name ?? this.dest.near ?? coordsText(this.dest);
    const input = $<HTMLInputElement>('route-save-name');
    input.value = input.placeholder = this.last ? `To ${place}` : this.dest.name ?? this.dest.near ?? `Pin ${place}`;
    input.focus();
    input.select();
  }

  private async save(name: string): Promise<void> {
    if (!this.dest || !this.onSave) return;
    const base = { id: newId(), name: name || $<HTMLInputElement>('route-save-name').placeholder, added: Date.now() };
    const item: Saved = this.last
      ? { ...base, kind: 'route', dest: this.dest, from: this.last.from, vias: this.vias, allowFRoads: this.allow, preferFRoads: this.prefer, route: this.last.route }
      : { ...base, kind: 'pin', lon: this.dest.lon, lat: this.dest.lat };
    try {
      await this.onSave(item);
      this.saved = true;
      this.showSaveForm(false);
      this.showSave();
    } catch (err) {
      this.setInfo($('route-info').textContent ?? '', $('route-off').textContent ?? '', `Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Shows a saved route as it was drawn (no planning), with its start and switches; changing
   *  those plans it again. Asks first when another route is on the map. */
  openSaved(r: SavedRoute): void {
    if (this.shown || this.planning) {
      this.ask(`Show ${r.name} and clear the current route?`, null, () => {
        this.clearRoute();
        this.openSaved(r);
      });
      return;
    }
    this.pick(r.dest);
    this.setVias(r.vias ?? []);
    this.clearStart();
    this.start = r.from;
    this.startPin = new maplibregl.Marker({ element: startPinElement(), anchor: 'bottom' }).setLngLat(r.from).addTo(this.map);
    this.allow = r.allowFRoads;
    this.prefer = r.preferFRoads;
    $<HTMLInputElement>('route-froads').checked = this.allow;
    $<HTMLInputElement>('route-prefer').checked = this.prefer;
    this.showStarted();
    this.showFrom();
    this.showRoute(r.route, r.from, 'chosen', true);
    $('route-title').textContent = r.name;
    this.saved = true;
    this.showSave();
  }

  private clearStart(): void {
    this.start = null;
    this.startPin?.remove();
    this.startPin = null;
  }

  private startKind(): StartKind {
    return this.start ? 'chosen' : this.searchFrom().gps ? 'gps' : 'centre';
  }

  private showFrom(): void {
    $('route-from-text').textContent = `From ${FROM_TEXT[this.startKind()]}`;
  }

  /** The "Use my location" / "Choose on the map" choices; choosing on the map is the emphasised
   *  one when there's no recent GPS position. */
  private showChoices(show: boolean): void {
    $('route-choices').hidden = !show;
    $('route-change').setAttribute('aria-expanded', String(show));
    $('route-choose').classList.toggle('primary', !this.searchFrom().gps);
  }

  private setInfo(info: string, off: string, msg: string): void {
    $('route-info').textContent = info;
    $('route-off').textContent = off;
    $('route-msg').textContent = msg;
    if (msg && this.minimized) this.setMinimized(false);
  }

  /** The F-road switches, on the route panel only; "Prefer" only while F-roads are allowed. */
  private showSwitches(): void {
    $('route-switch').hidden = !this.started;
    $('route-prefer-switch').hidden = !this.started || !this.allow;
  }

  /** The card as a route panel (title "To …", the F-road switch), for a route or its preparations. */
  private showStarted(): void {
    if (!this.dest) return;
    this.started = true;
    $('route-go').hidden = true;
    this.showSwitches();
    const place = this.dest.name ?? `dropped pin · ${this.dest.near ?? coordsText(this.dest)}`;
    $('route-title').textContent = this.dest.saved ? `Routing to ${place}` : `To ${place}`;
    this.showSave();
    this.onChange?.();
  }

  private async useMyLocation(): Promise<void> {
    this.showChoices(false);
    this.choosing = false;
    this.clearStart();
    this.showFrom();
    if (!this.dest) return;
    if (!this.searchFrom().gps) {
      const seq = ++this.seq;
      this.planning = false;
      this.useLocation();
      this.showStarted();
      this.drawRoute(EMPTY);
      this.setInfo('Waiting for your position…', '', '');
      const t0 = Date.now();
      this.waiting = true;
      while (!this.searchFrom().gps) {
        if (Date.now() - t0 > FIX_WAIT_MS) {
          this.waiting = false;
          this.setInfo('', '', "Couldn't get your position");
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
        if (seq !== this.seq) return; // cancelled: another pick, ×, or a new start
      }
      this.waiting = false;
    }
    void this.route();
  }

  private chooseOnMap(): void {
    this.showChoices(false);
    this.seq++; // a route in progress no longer applies
    this.planning = false;
    this.waiting = false;
    this.choosing = true;
    this.drawRoute(EMPTY);
    this.setInfo("Tap the map where you'll start", '', '');
  }

  private setStart(at: [number, number]): void {
    this.choosing = false;
    this.start = at;
    this.startPin?.remove();
    this.startPin = new maplibregl.Marker({ element: startPinElement(), anchor: 'bottom' }).setLngLat(at).addTo(this.map);
    this.showFrom();
    void this.route();
  }

  private async route(): Promise<void> {
    if (!this.dest) return;
    const seq = ++this.seq;
    this.choosing = false;
    this.waiting = false;
    const kind = this.startKind();
    const from = this.start ?? this.searchFrom().at;
    this.fromCentre = kind === 'centre' ? from : null;
    const fit = this.fitRoute;
    this.fitRoute = true;
    this.saved = false;
    this.last = null;
    this.showStarted();
    this.showFrom();
    this.setInfo('Preparing roads…', '', '');
    this.planning = true;
    // Leg by leg through the waypoints; a waypoint right at the previous stop adds no leg.
    const stops: LonLat[] = [from, ...this.vias.map((v): LonLat => [v.lon, v.lat]), [this.dest.lon, this.dest.lat]];
    const legs: RouteOk[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const reply = await this.plan(stops[i], stops[i + 1], this.allow, this.prefer).catch((err) => ({ status: 'error' as const, err }));
      if (seq !== this.seq) return; // superseded
      if (reply.status === 'ok') legs.push(reply);
      else if (reply.status !== 'same-place' || stops.length === 2) {
        this.planning = false;
        this.drawRoute(EMPTY);
        const leg = stops.length === 2 ? '' : i + 2 < stops.length ? `To waypoint ${i + 1}: ` : 'To the destination: ';
        this.setInfo('', '', leg + routeMessage(reply, i === 0 ? kind : 'chosen'));
        return;
      }
    }
    this.planning = false;
    if (!legs.length) {
      this.drawRoute(EMPTY);
      this.setInfo('', '', routeMessage({ status: 'same-place' }, kind));
      return;
    }
    this.showRoute(legs.length === 1 ? legs[0] : joinLegs(legs), from, kind, fit);
  }

  /** Draws a found (or saved) route with its numbers, and fits it in view when `fit`. */
  private showRoute(reply: JoinedRoute, from: [number, number], kind: StartKind, fit: boolean): void {
    const feature = (k: string, geometry: GeoJSON.Geometry): GeoJSON.Feature => ({ type: 'Feature', properties: { kind: k }, geometry });
    const features = [feature('route', { type: 'LineString', coordinates: reply.coords })];
    for (const leg of [reply.offRoadStart, reply.offRoadEnd, ...(reply.offRoadVia ?? [])]) if (leg) features.push(feature('offroad', { type: 'LineString', coordinates: leg }));
    // A chosen start has its pin; otherwise a dot marks where the route starts.
    if (kind !== 'chosen') features.push(feature('start', { type: 'Point', coordinates: reply.coords[0] }));
    this.drawRoute({ type: 'FeatureCollection', features });
    this.last = { route: reply, from };
    this.showSave();
    const via = this.vias.length ? ` · via ${this.vias.length} waypoint${this.vias.length === 1 ? '' : 's'}` : '';
    this.setInfo(`${fmtKm(reply.metres)} · ${fmtTime(reply.seconds)}${via}`, offRoadText(reply.offRoadStartM, reply.offRoadEndM), '');
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of [...reply.coords, ...(reply.offRoadStart ?? []), ...(reply.offRoadEnd ?? [])]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    if (!fit) return;
    const card = $('route-card').getBoundingClientRect();
    const bottom = this.map.getContainer().getBoundingClientRect().bottom - card.top + 20;
    this.map.fitBounds([[w, s], [e, n]], { padding: { top: 80, bottom: Math.max(60, bottom), left: 40, right: 40 }, maxZoom: 15, duration: 800 });
  }
}
