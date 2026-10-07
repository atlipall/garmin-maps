import * as maplibregl from 'maplibre-gl';

export interface PlaceMenuItem {
  /** Element id of the button (for tests and focus). */
  id: string;
  label: string;
  run: () => void;
}

/**
 * A small menu at a place on the map (a MapLibre popup, so it stays on the place when the map
 * moves): what to do with a place picked while a route is shown. Choosing an item runs it and
 * closes the menu; Escape or `close()` (a tap elsewhere, the app's menu) just closes it.
 */
/** Clear of the grey pin marking the place (about 41 px tall, standing on the point). */
const OFFSET: maplibregl.Offset = {
  bottom: [0, -44], 'bottom-left': [8, -44], 'bottom-right': [-8, -44],
  top: [0, 8], 'top-left': [8, 8], 'top-right': [-8, 8],
  left: [14, -20], right: [-14, -20], center: [0, 0],
};

export class PlaceMenu {
  private popup: maplibregl.Popup | null = null;
  private onCancel: (() => void) | null = null;

  constructor(private readonly map: maplibregl.Map) {}

  get isOpen(): boolean {
    return this.popup !== null;
  }

  /** Opens the menu at `at` titled `title`; `onCancel` runs if it closes without a choice. */
  open(at: [number, number], title: string, items: PlaceMenuItem[], onCancel: () => void): void {
    this.close();
    const box = document.createElement('div');
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-labelledby', 'place-menu-title');
    const head = document.createElement('div');
    head.id = 'place-menu-title';
    head.textContent = title;
    box.append(head);
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = item.id;
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.onclick = () => {
        this.onCancel = null; // a choice, not a cancel
        this.close();
        item.run();
      };
      box.append(b);
    }
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.close();
    });
    this.onCancel = onCancel;
    // Closed by its owner, not by MapLibre: a long press ends with a click that would close it.
    this.popup = new maplibregl.Popup({ className: 'place-menu', closeButton: false, closeOnClick: false, maxWidth: '280px', offset: OFFSET })
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(this.map);
    queueMicrotask(() => box.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
  }

  close(): void {
    const popup = this.popup;
    const cancel = this.onCancel;
    this.popup = null;
    this.onCancel = null;
    popup?.remove();
    cancel?.();
  }
}
