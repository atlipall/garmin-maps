import type * as maplibregl from 'maplibre-gl';

const CAMERA_PLUS_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 6H9l-1.5 2H4.5A1.5 1.5 0 0 0 3 9.5v9A1.5 1.5 0 0 0 4.5 20h13a1.5 1.5 0 0 0 1.5-1.5V13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="11" cy="14" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M18 2.5v6M15 5.5h6" stroke="#1d3f8f" stroke-width="2.2" stroke-linecap="round"/></svg>';

/**
 * Adding photos from the map: a button left of save-a-pin (shown while location is on) opens the
 * photo picker, where the iPhone also offers Take Photo. A photo without a location of its own (the
 * camera through Safari may leave it out) can then be put where you are, if you choose to.
 */
export class PhotoHere implements maplibregl.IControl {
  private readonly container = document.createElement('div');

  constructor(pick: () => void) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group photo-here';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo-here-button';
    button.setAttribute('aria-label', 'Add a photo here');
    button.title = 'Add a photo here';
    button.innerHTML = CAMERA_PLUS_ICON;
    button.onclick = pick;
    this.container.append(button);
    this.setAvailable(false);
  }

  onAdd(): HTMLElement {
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }

  /** Location on (the button shows) or off (it hides). */
  setAvailable(on: boolean): void {
    this.container.hidden = !on;
  }
}
