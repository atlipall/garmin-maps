import type * as maplibregl from 'maplibre-gl';
import { deleteSaved, listSaved, putSaved, type Saved, type SavedPin, type SavedRoute } from '../saved/saved';
import { coordsText, fmtKm, fmtTime } from './route';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A delete button asks "Delete?" and needs a second tap within this time (ms). */
const CONFIRM_MS = 3000;
const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STAR = '★';
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
  private readonly panel = $('saved');
  private readonly list = $<HTMLUListElement>('saved-list');
  private readonly error = $('saved-error');

  constructor(
    private readonly map: maplibregl.Map,
    font: string,
    private readonly openPin: (p: SavedPin) => void,
    private readonly openRoute: (r: SavedRoute) => void,
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
    listSaved().then((items) => {
      this.items = items;
      this.refresh();
    }, (err) => this.fail(err));
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
    li.append(icon, info, del);
    return li;
  }

  private async remove(s: Saved): Promise<void> {
    try {
      await deleteSaved(s.id);
      this.items = this.items.filter((x) => x.id !== s.id);
      this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error.textContent = err instanceof Error ? err.message : String(err);
  }
}
