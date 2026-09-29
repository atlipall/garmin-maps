import type * as maplibregl from 'maplibre-gl';
import type { StoredTrack } from './store';

/** Track colours: distinct from the map's roads (orange/yellow), water (blue) and vegetation. */
export const TRACK_COLORS = ['#d6249f', '#7c3aed', '#e03e0f', '#0891b2', '#b91c5c', '#4f46e5'];

/** The first colour no current track uses (cycling once all are taken). */
export function nextColor(tracks: Array<Pick<StoredTrack, 'color'>>): string {
  const used = new Set(tracks.map((t) => t.color));
  return TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[tracks.length % TRACK_COLORS.length];
}

/** GeoJSON for the visible tracks: their lines, and their waypoints as points. */
export function tracksGeoJson(tracks: StoredTrack[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of tracks) {
    if (!t.visible) continue;
    for (const l of t.gpx.lines) {
      features.push({ type: 'Feature', properties: { id: t.id, color: t.color }, geometry: { type: 'LineString', coordinates: l.points.map((p) => [p.lon, p.lat]) } });
    }
    for (const w of t.gpx.waypoints) {
      features.push({ type: 'Feature', properties: { id: t.id, color: t.color, name: w.name ?? '' }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** [[west, south], [east, north]] of a track's lines and waypoints. */
export function trackBounds(t: StoredTrack): [[number, number], [number, number]] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (lon: number, lat: number) => {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  };
  for (const l of t.gpx.lines) for (const p of l.points) add(p.lon, p.lat);
  for (const p of t.gpx.waypoints) add(p.lon, p.lat);
  return [[w, s], [e, n]];
}

/** Adds the 'gpx' source and its layers on top of the map style. */
export function addTrackLayers(map: maplibregl.Map, font: string): void {
  map.addSource('gpx', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const width = (lo: number, hi: number) => ['interpolate', ['linear'], ['zoom'], 8, lo, 15, hi] as unknown as number;
  map.addLayer({ id: 'gpx-casing', type: 'line', source: 'gpx', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': width(4, 8), 'line-opacity': 0.9 } });
  map.addLayer({ id: 'gpx-line', type: 'line', source: 'gpx', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': width(2.5, 5) } });
  map.addLayer({ id: 'gpx-waypoints', type: 'circle', source: 'gpx', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'gpx-waypoint-labels', type: 'symbol', source: 'gpx', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'name'], '']],
    layout: { 'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-max-width': 10 },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
}
