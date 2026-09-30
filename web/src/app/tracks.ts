import type * as maplibregl from 'maplibre-gl';
import { addTrackLayers, nextColor, trackBounds, tracksGeoJson } from '../gpx/layers';
import { parseGpx } from '../gpx/parse';
import { climb, formatStats, summarize } from '../gpx/stats';
import { deleteTrack, listTracks, putTrack, type StoredTrack } from '../gpx/store';
import { noteDeleted } from '../saved/deleted';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Points at least this far apart (m) are sampled when filling in heights from the elevation files. */
const HEIGHT_SAMPLE_M = 25;
const HEIGHT_SAMPLE_MAX = 4000;
/** A delete button asks "Delete?" and needs a second tap within this time (ms). */
const CONFIRM_MS = 3000;

const approxMetres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
  Math.hypot((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 111_195;

/** The first and last point, and those in between at least `spacing` metres from the previous kept one. */
function sample<P extends { lon: number; lat: number }>(points: P[], spacing: number): P[] {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (approxMetres(out[out.length - 1], points[i]) >= spacing) out.push(points[i]);
  out.push(points[points.length - 1]);
  return out;
}

const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The Tracks panel (⋯ → Tracks): imports GPX files, keeps them on the device, draws the visible
 * ones on the map, and lists them with their distance, climb and time.
 */
export class TracksPanel {
  private tracks: StoredTrack[] = [];
  /** Called after a change made here (import, show or hide, delete), for syncing. */
  onChanged: (() => void) | null = null;
  private readonly panel = $('tracks');
  private readonly list = $<HTMLUListElement>('track-list');
  private readonly error = $('tracks-error');

  constructor(
    private readonly map: maplibregl.Map,
    private readonly elevations: (coords: Array<[number, number]>) => Promise<Array<number | null>>,
    font: string,
  ) {
    addTrackLayers(map, font);
    const input = $<HTMLInputElement>('gpx-file');
    $('import-gpx').onclick = () => input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      void this.importFiles(files);
    };
    $('tracks-close').onclick = () => this.show(false);
    void this.reload();
  }

  /** Reads the tracks from storage again (after a restore or a sync). */
  async reload(): Promise<void> {
    try {
      this.tracks = await listTracks();
      this.refresh();
      for (const tr of this.tracks) if (tr.stats.climb === null) void this.fillClimb(tr);
    } catch (err) {
      this.fail(err);
    }
  }

  show(open: boolean): void {
    this.panel.hidden = !open;
    if (open) this.error.textContent = '';
  }

  /** Number of stored tracks (for tests). */
  get count(): number {
    return this.tracks.length;
  }

  async importFiles(files: File[]): Promise<void> {
    this.error.textContent = '';
    const problems: string[] = [];
    let last: StoredTrack | null = null;
    for (const file of files) {
      try {
        const gpx = parseGpx(await file.text());
        const track: StoredTrack = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: gpx.name ?? gpx.lines.find((l) => l.name)?.name ?? file.name.replace(/\.gpx$/i, ''),
          color: nextColor(this.tracks),
          visible: true,
          added: Date.now(),
          stats: summarize(gpx),
          gpx,
        };
        await putTrack(track);
        this.tracks.push(track);
        last = track;
        if (track.stats.climb === null) void this.fillClimb(track);
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.refresh();
    if (last) this.onChanged?.();
    if (problems.length) this.error.textContent = problems.join('\n');
    if (last) this.zoomTo(last);
  }

  /** Climb for a GPX without heights, from the elevation files (sampled along the lines). */
  private async fillClimb(track: StoredTrack): Promise<void> {
    if (!track.gpx.lines.length) return;
    const spacing = Math.max(HEIGHT_SAMPLE_M, track.stats.distance / HEIGHT_SAMPLE_MAX);
    const lines = track.gpx.lines.map((l) => sample(l.points, spacing));
    try {
      const heights = await this.elevations(lines.flat().map((p) => [p.lon, p.lat]));
      let k = 0;
      const value = climb(lines.map((l) => l.map(() => heights[k++])));
      if (value === null) return;
      track.stats = { ...track.stats, climb: value };
      track.updated = Date.now();
      await putTrack(track);
      this.refresh();
      this.onChanged?.();
    } catch {
      // No elevation files or a worker error: the climb just stays unknown.
    }
  }

  /** Fits the track in view, keeping it clear of this panel while it is open. */
  private zoomTo(t: StoredTrack): void {
    const top = this.panel.hidden ? 60 : this.panel.getBoundingClientRect().bottom - this.map.getContainer().getBoundingClientRect().top + 30;
    const room = this.map.getContainer().clientHeight - top - 60;
    this.map.fitBounds(trackBounds(t), { padding: { top: room > 120 ? top : 60, bottom: 60, left: 40, right: 40 }, maxZoom: 15, duration: 800 });
  }

  private refresh(): void {
    (this.map.getSource('gpx') as maplibregl.GeoJSONSource | undefined)?.setData(tracksGeoJson(this.tracks));
    $('tracks-empty').hidden = this.tracks.length > 0;
    this.list.replaceChildren(...this.tracks.map((t) => this.row(t)));
  }

  private row(t: StoredTrack): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = t.id;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = t.color;
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'track-info';
    info.title = 'Show on the map';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    const stats = document.createElement('span');
    stats.className = 'stats';
    stats.textContent = formatStats(t.stats) || `${t.gpx.waypoints.length} waypoints`;
    info.append(name, stats);
    info.onclick = () => {
      if (!t.visible) void this.setVisible(t, true);
      this.zoomTo(t);
      if (matchMedia('(pointer: coarse)').matches) this.show(false);
    };
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'track-eye';
    eye.setAttribute('aria-pressed', String(t.visible));
    eye.setAttribute('aria-label', t.visible ? `Hide ${t.name}` : `Show ${t.name}`);
    eye.innerHTML = t.visible
      ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2" opacity=".45"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/></svg>';
    eye.onclick = () => void this.setVisible(t, !t.visible);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'track-delete';
    del.setAttribute('aria-label', `Delete ${t.name}`);
    del.innerHTML = TRASH;
    let timer = 0;
    del.onclick = () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Delete?';
        timer = window.setTimeout(() => {
          del.classList.remove('confirm');
          del.innerHTML = TRASH;
        }, CONFIRM_MS);
        return;
      }
      clearTimeout(timer);
      void this.remove(t);
    };
    li.append(swatch, info, eye, del);
    return li;
  }

  private async setVisible(t: StoredTrack, visible: boolean): Promise<void> {
    t.visible = visible;
    t.updated = Date.now();
    this.refresh();
    await putTrack(t).catch((err) => this.fail(err));
    this.onChanged?.();
  }

  private async remove(t: StoredTrack): Promise<void> {
    try {
      await deleteTrack(t.id);
      noteDeleted(t.id);
      this.tracks = this.tracks.filter((x) => x.id !== t.id);
      this.refresh();
      this.onChanged?.();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error.textContent = err instanceof Error ? err.message : String(err);
  }
}
