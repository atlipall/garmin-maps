import * as maplibregl from 'maplibre-gl';
import type { RouteReply } from '../worker/pool';
import { readSetting, writeSetting } from '../ui/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LONG_PRESS_MS = 550;

const fmtKm = (m: number) => (m < 10_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);
function fmtTime(s: number): string {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const MESSAGES: Record<Exclude<RouteReply['status'], 'ok'>, string> = {
  'no-road-start': 'No road near your position',
  'no-road-end': 'No road within 2 km of the destination',
  'no-route': 'No route without F-roads and tracks: turn the switch on to allow them',
};

/** Destination card, route panel and route line (route planning without guidance). */
export class RoutePlanner {
  private pin: maplibregl.Marker | null = null;
  private dest: { name: string | null; lon: number; lat: number } | null = null;
  private allow = readSetting('allowFRoads', true);
  private started = false;
  private seq = 0;

  constructor(
    private readonly map: maplibregl.Map,
    private readonly plan: (from: [number, number], to: [number, number], allow: boolean) => Promise<RouteReply>,
    private readonly searchFrom: () => { at: [number, number]; gps: boolean },
  ) {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 15, 11] } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 15, 7] } });
    $<HTMLInputElement>('route-froads').checked = this.allow;
    $('route-go').onclick = () => void this.route();
    $('route-close').onclick = () => this.clear();
    $<HTMLInputElement>('route-froads').onchange = (e) => {
      this.allow = (e.target as HTMLInputElement).checked;
      writeSetting('allowFRoads', this.allow);
      if (this.started) void this.route();
    };
    // Long press (touch) or right-click (mouse) drops a pin with a "Route here" card.
    map.on('contextmenu', (e) => this.pick({ name: null, lon: e.lngLat.lng, lat: e.lngLat.lat }));
    let timer = 0;
    let startXY: [number, number] | null = null;
    const canvas = map.getCanvasContainer();
    canvas.addEventListener('touchstart', (e) => {
      clearTimeout(timer);
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startXY = [t.clientX, t.clientY];
      timer = window.setTimeout(() => {
        const r = canvas.getBoundingClientRect();
        const ll = map.unproject([startXY![0] - r.left, startXY![1] - r.top]);
        this.pick({ name: null, lon: ll.lng, lat: ll.lat });
      }, LONG_PRESS_MS);
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (startXY && Math.hypot(t.clientX - startXY[0], t.clientY - startXY[1]) > 10) clearTimeout(timer);
    }, { passive: true });
    for (const ev of ['touchend', 'touchcancel']) canvas.addEventListener(ev, () => clearTimeout(timer));
  }

  /** Shows the destination card for a place (from search or a long press). */
  pick(dest: { name: string | null; lon: number; lat: number }): void {
    this.clearRoute();
    this.dest = dest;
    this.pin?.remove();
    this.pin = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([dest.lon, dest.lat]).addTo(this.map);
    $('route-title').textContent = dest.name ?? `Dropped pin · ${dest.lat.toFixed(4)}, ${dest.lon.toFixed(4)}`;
    $('route-info').textContent = '';
    $('route-msg').textContent = '';
    $('route-switch').hidden = true;
    $('route-go').hidden = false;
    $('route-card').hidden = false;
  }

  clear(): void {
    this.clearRoute();
    this.pin?.remove();
    this.pin = null;
    this.dest = null;
    $('route-card').hidden = true;
  }

  private clearRoute(): void {
    this.seq++;
    this.started = false;
    (this.map.getSource('route') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  }

  private async route(): Promise<void> {
    if (!this.dest) return;
    const seq = ++this.seq;
    this.started = true;
    const from = this.searchFrom();
    $('route-go').hidden = true;
    $('route-switch').hidden = false;
    $('route-title').textContent = `To ${this.dest.name ?? 'dropped pin'}`;
    $('route-msg').textContent = '';
    $('route-info').textContent = 'Preparing roads…';
    const reply = await this.plan(from.at, [this.dest.lon, this.dest.lat], this.allow).catch((err) => ({ status: 'error' as const, err }));
    if (seq !== this.seq) return; // superseded
    const source = this.map.getSource('route') as maplibregl.GeoJSONSource;
    if (reply.status !== 'ok') {
      source.setData({ type: 'FeatureCollection', features: [] });
      $('route-info').textContent = '';
      $('route-msg').textContent = reply.status === 'error' ? String((reply as { err: unknown }).err) : MESSAGES[reply.status];
      return;
    }
    source.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: reply.coords } });
    $('route-info').textContent = `${fmtKm(reply.metres)} · ${fmtTime(reply.seconds)} · ${from.gps ? 'from your position' : 'from the map centre'}`;
    const lons = reply.coords.map((c) => c[0]);
    const lats = reply.coords.map((c) => c[1]);
    const card = $('route-card').getBoundingClientRect();
    const bottom = this.map.getContainer().getBoundingClientRect().bottom - card.top + 20;
    this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 80, bottom: Math.max(60, bottom), left: 40, right: 40 }, maxZoom: 15, duration: 800 });
  }
}
