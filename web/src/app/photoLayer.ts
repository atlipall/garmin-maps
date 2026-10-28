import * as maplibregl from 'maplibre-gl';
import { cluster } from '../photos/cluster';
import { byTime, type Photo } from '../photos/photo';

/** Photos closer than this on screen (px) are one thumbnail with a count. */
const GROUP_PX = 56;

/**
 * Photos on the map: round thumbnails at their spot, those close together on screen as one with a
 * count, regrouped when the map stops moving. A tap opens the group's photos.
 */
export class PhotoLayer {
  private photos: Photo[] = [];
  private markers: maplibregl.Marker[] = [];
  private visible = true;

  constructor(
    private readonly map: maplibregl.Map,
    /** The thumbnail's address (an object URL), when it's here. */
    private readonly thumb: (id: string) => Promise<string | null>,
    private readonly open: (photos: Photo[]) => void,
  ) {
    map.on('moveend', () => this.draw());
  }

  set(photos: Photo[]): void {
    this.photos = photos;
    this.draw();
  }

  show(on: boolean): void {
    this.visible = on;
    this.draw();
  }

  /** The groups as drawn (for tests): each one's photo ids. */
  get groups(): string[][] {
    return this.markers.map((m) => (m.getElement().dataset.ids ?? '').split(','));
  }

  private draw(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
    if (!this.visible || !this.photos.length) return;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const pad = GROUP_PX;
    const pts = [...this.photos].sort(byTime).flatMap((p) => {
      const { x, y } = this.map.project([p.lon, p.lat]);
      return x < -pad || y < -pad || x > w + pad || y > h + pad ? [] : [{ item: p, x, y }];
    });
    for (const g of cluster(pts, GROUP_PX)) {
      const first = g.items[0];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'photo-pin';
      el.dataset.ids = g.items.map((p) => p.id).join(',');
      el.setAttribute('aria-label', g.items.length === 1 ? 'Photo' : `${g.items.length} photos`);
      if (g.items.length > 1) {
        const n = document.createElement('span');
        n.className = 'count';
        n.textContent = String(g.items.length);
        el.append(n);
      }
      // The map shouldn't take the tap as one of its own (a long press picks a place there).
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open(g.items);
      });
      void this.thumb(first.id).then((url) => url && (el.style.backgroundImage = `url("${url}")`));
      this.markers.push(new maplibregl.Marker({ element: el }).setLngLat([first.lon, first.lat]).addTo(this.map));
    }
  }
}
