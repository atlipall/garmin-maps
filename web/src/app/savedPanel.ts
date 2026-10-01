import type * as maplibregl from 'maplibre-gl';
import { deleteSaved, listSaved, putSaved, type Saved, type SavedPin, type SavedRoute } from '../saved/saved';
import { listTracks, putTrack, type StoredTrack } from '../gpx/store';
import { backupFileName, makeBackup, parseBackup, toStore } from '../saved/backup';
import { deletions, noteDeleted, setDeletions } from '../saved/deleted';
import { gpxFileName, routeGpx, shareFile } from '../gpx/export';
import { coordsText, fmtKm, fmtTime } from './route';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A delete button asks "Delete?" and needs a second tap within this time (ms). */
const CONFIRM_MS = 3000;
const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STAR = '★';
const SHARE = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ROUTE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="6" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 17c6 0 2-9 8-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The list line under a saved item's name. */
export function savedDetails(s: Saved): string {
  return s.kind === 'pin' ? coordsText(s) : `${fmtKm(s.route.metres)} · ${fmtTime(s.route.seconds)} · ${dateText(s.added)}`;
}

/** A small gold star with a dark outline, for saved pins on the map. */
function starImage(): ImageData {
  const size = 44; // 2x for sharp edges on high-density screens
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? size * 0.2 : size * 0.46;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(size / 2 + r * Math.cos(a), size / 2 + 2 + r * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = '#f4b400';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#6b4e00';
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

/**
 * The Saved panel (⋯ → Saved): pins and routes saved from the route card, kept on the device. Saved
 * pins are always shown on the map as stars; a tap on one (or on it in the list) opens its card.
 * A saved route opens as it was drawn.
 */
export class SavedPanel {
  private items: Saved[] = [];
  /** Called after a change made here (save, delete, restore), for syncing. */
  onChanged: (() => void) | null = null;
  private readonly panel = $('saved');
  private readonly list = $<HTMLUListElement>('saved-list');
  private readonly error = $('saved-error');

  constructor(
    private readonly map: maplibregl.Map,
    font: string,
    private readonly openPin: (p: SavedPin) => void,
    private readonly openRoute: (r: SavedRoute) => void,
    /** Reads the GPX tracks again after a restore brought some in. */
    private readonly reloadTracks: () => Promise<void>,
    /** The GPX tracks as the Tracks panel holds them. */
    private readonly tracksNow: () => StoredTrack[] = () => [],
  ) {
    map.addImage('saved-star', starImage(), { pixelRatio: 2 });
    map.addSource('saved', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'saved-pins',
      type: 'symbol',
      source: 'saved',
      layout: {
        'icon-image': 'saved-star',
        'icon-allow-overlap': true,
        'text-field': ['get', 'name'],
        'text-font': [font],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': '#4a3700', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
    map.on('click', 'saved-pins', (e) => {
      const id = e.features?.[0]?.properties?.id;
      const pin = this.items.find((s): s is SavedPin => s.kind === 'pin' && s.id === id);
      if (pin) this.openPin(pin);
    });
    map.on('mouseenter', 'saved-pins', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'saved-pins', () => (map.getCanvas().style.cursor = ''));
    $('saved-close').onclick = () => this.show(false);
    $('backup-save').onclick = () => void this.backup().catch((err) => this.fail(err));
    const input = $<HTMLInputElement>('backup-file');
    $('backup-restore').onclick = () => input.click();
    input.onchange = () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.restore(file).catch((err) => this.fail(err));
    };
    void this.reload();
  }

  /** Reads the saved items from storage again (after a restore or a sync). */
  async reload(): Promise<void> {
    try {
      this.items = await listSaved();
      this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Everything saved plus the GPX tracks, as one file (the share sheet on a phone, else a download). */
  /** Built from what the panels already hold, without waiting on storage: iOS lets a tap open the
   *  share sheet only straight away. */
  private async backup(): Promise<void> {
    this.status('');
    const text = JSON.stringify(makeBackup(this.items, this.tracksNow(), deletions()));
    await shareFile(backupFileName(), text, 'application/json');
  }

  /** Brings in what a backup has that this device doesn't (or has an older copy of); deletes nothing. */
  private async restore(file: File): Promise<void> {
    this.status('');
    const b = parseBackup(await file.text());
    const saved = toStore(await listSaved(), b.saved);
    const tracks = toStore(await listTracks(), b.tracks);
    // Restoring is wanting them back: they count as just changed, which also outweighs a deletion of
    // them remembered here or on another device.
    const now = Date.now();
    const gone = deletions();
    for (const s of saved) {
      await putSaved({ ...s, updated: now });
      delete gone[s.id];
    }
    for (const t of tracks) {
      await putTrack({ ...t, updated: now });
      delete gone[t.id];
    }
    setDeletions(gone);
    await this.reload();
    if (tracks.length) await this.reloadTracks();
    if (saved.length || tracks.length) this.onChanged?.();
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    this.status(saved.length || tracks.length ? `Restored ${n(saved.length, 'saved item', 'saved items')} and ${n(tracks.length, 'track', 'tracks')}.` : 'Nothing new in this backup: everything in it is already here.');
  }

  private status(text: string): void {
    $('backup-status').textContent = text;
    this.error.textContent = '';
  }

  show(open: boolean): void {
    this.panel.hidden = !open;
    if (open) this.error.textContent = '';
  }

  /** Number of saved items (for tests). */
  get count(): number {
    return this.items.length;
  }

  async add(item: Saved): Promise<void> {
    await putSaved(item);
    this.items.push(item);
    this.refresh();
    this.onChanged?.();
  }

  private refresh(): void {
    const pins = this.items.filter((s): s is SavedPin => s.kind === 'pin');
    (this.map.getSource('saved') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: pins.map((p) => ({ type: 'Feature', properties: { id: p.id, name: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
    });
    $('saved-empty').hidden = this.items.length > 0;
    this.list.replaceChildren(...this.items.map((s) => this.row(s)));
  }

  private row(s: Saved): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'track saved-item';
    li.dataset.id = s.id;
    const icon = document.createElement('span');
    icon.className = `saved-icon ${s.kind}`;
    if (s.kind === 'pin') icon.textContent = STAR;
    else icon.innerHTML = ROUTE_ICON;
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'track-info';
    info.title = 'Show on the map';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const details = document.createElement('span');
    details.className = 'stats';
    details.textContent = savedDetails(s);
    info.append(name, details);
    info.onclick = () => {
      if (s.kind === 'pin') this.openPin(s);
      else this.openRoute(s);
      if (matchMedia('(pointer: coarse)').matches) this.show(false);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'track-delete';
    del.setAttribute('aria-label', `Delete ${s.name}`);
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
      void this.remove(s);
    };
    if (s.kind === 'route') {
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'track-eye saved-export';
      share.setAttribute('aria-label', `Export ${s.name} as GPX`);
      share.title = 'Export GPX';
      share.innerHTML = SHARE;
      share.onclick = () => void this.exportRoute(s).catch((err) => this.fail(err));
      li.append(icon, info, share, del);
    } else li.append(icon, info, del);
    return li;
  }

  private async exportRoute(r: SavedRoute): Promise<void> {
    const vias = r.vias ?? [];
    const via = vias.length ? ` · via ${vias.length} waypoint${vias.length === 1 ? '' : 's'}` : '';
    const gpx = routeGpx({ name: r.name, summary: `${fmtKm(r.route.metres)} · ${fmtTime(r.route.seconds)}${via}`, route: r.route, start: r.route.offRoadStart?.[0] ?? r.from, vias, dest: r.dest });
    await shareFile(gpxFileName(r.name), gpx);
  }

  private async remove(s: Saved): Promise<void> {
    try {
      await deleteSaved(s.id);
      noteDeleted(s.id);
      this.items = this.items.filter((x) => x.id !== s.id);
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
