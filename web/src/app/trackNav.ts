import type * as maplibregl from 'maplibre-gl';
import type { StoredTrack } from '../gpx/store';
import type { LonLat, RoadSeg, RouteReply } from '../routing/plan';
import { nearestAhead, routeAlongTrack, trackLine, type TrackLine } from '../tracks/plan';
import type { Fix } from './location';
import type { Navigator } from './navigation';

/** Closer than this (m) to a track is on it: navigation starts right there (no way to it). */
export const ON_TRACK_M = 30;

export interface TrackNavDeps {
  map: maplibregl.Map;
  navigator: Navigator;
  /** Your position, if there is a recent fix. */
  fix(): Fix | null;
  /** Location on, following heading up (as Start on a route does). */
  follow(): void;
  /** A road route between two points. */
  plan(from: LonLat, to: LonLat): Promise<RouteReply>;
  /** Road stretches along a line, matched to the map's roads. */
  match(coords: LonLat[], times: Array<number | null>): Promise<RoadSeg[]>;
}

interface Active {
  track: StoredTrack;
  line: TrackLine;
  segs: RoadSeg[];
  /** Where the current guidance joins the track (m along it) and the length of the way there. */
  joinAlong: number;
  approachM: number;
}

/**
 * Navigating a track: from where you are to its nearest point ahead (a road route, or straight
 * there where no road goes), then along it to its end with turn instructions (a saved route's own;
 * an imported track's matched to the roads, with its trail bends). Leaving it on a road plans the
 * way back to it ahead of where you left; the navigator handles leaving it on a trail.
 */
export class TrackNav {
  private active_: Active | null = null;
  /** Matched stretches per track and direction, for this session. */
  private readonly matched = new Map<string, Promise<RoadSeg[]>>();

  constructor(private readonly deps: TrackNavDeps) {
    deps.map.addSource('track-nav', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    deps.map.addLayer({ id: 'track-nav-casing', type: 'line', source: 'track-nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 15, 11] } });
    deps.map.addLayer({ id: 'track-nav-line', type: 'line', source: 'track-nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 15, 7] } });
  }

  get active(): boolean {
    return this.active_ !== null;
  }

  /** The track's road stretches: a saved route's own (as saved), else matched to the roads. */
  segsFor(track: StoredTrack, reverse: boolean): Promise<RoadSeg[]> {
    if (track.route && !reverse) return Promise.resolve(track.route.segs);
    const key = `${track.id}:${reverse}`;
    let p = this.matched.get(key);
    if (!p) {
      const line = trackLine(track, reverse);
      this.matched.set(key, (p = this.deps.match(line.coords, line.times)));
      p.catch(() => this.matched.delete(key));
    }
    return p;
  }

  /** Starts guidance along `track` (turned round for `reverse`). */
  async start(track: StoredTrack, reverse: boolean): Promise<void> {
    const line = trackLine(track, reverse);
    const segs = await this.segsFor(track, reverse);
    this.active_ = { track, line, segs, joinAlong: 0, approachM: 0 };
    this.deps.follow();
    await this.go(0);
  }

  /** Off the track on a road: back to it, ahead of where you had got to (`along` on the guidance). */
  rejoin(along: number): void {
    const a = this.active_;
    if (!a) return;
    const trackAlong = along <= a.approachM ? a.joinAlong : a.joinAlong + (along - a.approachM);
    void this.go(trackAlong).catch(() => this.deps.navigator.couldNotReplan());
  }

  /** Navigation ended. */
  ended(): void {
    this.active_ = null;
    this.draw([]);
  }

  private async go(fromAlong: number): Promise<void> {
    const a = this.active_;
    if (!a) return;
    const fix = this.deps.fix();
    const at = fix?.at ?? null;
    const join = at ? nearestAhead(a.line, at, fromAlong) : { index: 0, point: a.line.coords[0], along: 0, off: 0 };
    let approach: Extract<RouteReply, { status: 'ok' }> | null = null;
    let straightFrom: LonLat | null = null;
    if (at && join.off > ON_TRACK_M) {
      const reply = await this.deps.plan(at, join.point).catch(() => null);
      if (reply?.status === 'ok') approach = reply;
      else straightFrom = at;
    }
    if (this.active_ !== a) return; // ended meanwhile
    const { route, approachM } = routeAlongTrack(a.track.name, a.line, a.segs, join, straightFrom, approach);
    a.joinAlong = join.along;
    a.approachM = approachM;
    this.draw(route.coords);
    this.deps.navigator.start({ route, title: a.track.name, dest: `the end of ${a.track.name}`, track: true }, fix);
  }

  /** The route being navigated, drawn like a planned route: the way to the track and the track
   *  from where it joins to its end (the part behind the join stays in the track's colour). */
  private draw(coords: LonLat[]): void {
    (this.deps.map.getSource('track-nav') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [],
    });
  }
}
