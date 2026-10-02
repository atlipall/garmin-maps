import type * as maplibregl from 'maplibre-gl';
import { newId, type SavedPin } from '../saved/saved';
import type { Fix } from './location';
import { coordsText } from './route';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** How long "Saved … · Undo" stays up. */
const TOAST_MS = 6000;

const PIN_PLUS_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 12 3.5M12 21s6.5-5.6 6.5-11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 2.5v6M13 5.5h6" stroke="#2c5a85" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/></svg>';

export interface SaveHereDeps {
  /** Your position, if there is a recent fix. */
  fix(): Fix | null;
  /** The ground height (m) at a point, null when unknown. */
  height(lon: number, lat: number): Promise<number | null>;
  /** A name for where you are (the map feature there, or the town nearby), if there is one. */
  suggest(at: [number, number]): string | undefined;
  save(pin: SavedPin): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Saving a pin where you are: a button by the locate button (shown while location is on) opens a
 * small card to name it; the ☆ in the navigation panel saves at once with the suggested name (no
 * typing while driving). Either way "Saved …" offers Undo for a few seconds. Kept apart from the
 * route card, so saving your position never disturbs a route.
 */
export class SaveHere implements maplibregl.IControl {
  private readonly container = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly card = $('here-card');
  private readonly input = $<HTMLInputElement>('here-name');
  /** Where the open card saves: the position when it was opened (you may walk on while typing). */
  private at: Fix | null = null;
  private toastTimer = 0;
  private lastSaved: string | null = null;

  constructor(private readonly deps: SaveHereDeps) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group save-here';
    this.button.type = 'button';
    this.button.className = 'save-here-button';
    this.button.setAttribute('aria-label', 'Save my location');
    this.button.title = 'Save my location';
    this.button.innerHTML = PIN_PLUS_ICON;
    this.button.onclick = () => this.open();
    this.container.append(this.button);
    this.setAvailable(false);
    $<HTMLFormElement>('here-form').onsubmit = (e) => {
      e.preventDefault();
      void this.saveOpen();
    };
    $('here-cancel').onclick = $('here-close').onclick = () => this.close();
    $('nav-save').onclick = () => void this.quick();
    $('here-undo').onclick = () => void this.undo();
  }

  onAdd(): HTMLElement {
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }

  /** Location on (the button shows) or off (it hides, with its card). */
  setAvailable(on: boolean): void {
    this.container.hidden = !on;
    if (!on) this.close();
  }

  /** The card: your position, its height and a name to save it under. */
  private open(): void {
    const fix = this.deps.fix();
    if (!fix) return this.toast('No position yet: wait for the GPS.', false);
    this.at = fix;
    const [lon, lat] = fix.at;
    const sub = $('here-sub');
    const where = `${coordsText({ lon, lat })} · ±${Math.round(fix.accuracy)} m`;
    sub.textContent = where;
    void this.deps.height(lon, lat).then((h) => {
      if (this.at === fix && h !== null) sub.textContent = `${Math.round(h)} m · ${where}`;
    });
    $('here-error').textContent = '';
    this.input.value = this.input.placeholder = this.name(fix);
    this.card.hidden = false;
    document.body.classList.add('saving-here');
    this.input.focus();
    this.input.select();
  }

  private close(): void {
    this.at = null;
    this.card.hidden = true;
    document.body.classList.remove('saving-here');
  }

  private async saveOpen(): Promise<void> {
    if (!this.at) return;
    try {
      await this.store(this.at, this.input.value.trim() || this.input.placeholder);
      this.close();
    } catch (err) {
      $('here-error').textContent = `Couldn't save: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Navigating: one tap saves where you are under the suggested name. */
  private async quick(): Promise<void> {
    const fix = this.deps.fix();
    if (!fix) return this.toast('No position yet: wait for the GPS.', false);
    await this.store(fix, this.name(fix)).catch((err) => this.toast(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`, false));
  }

  private async store(fix: Fix, name: string): Promise<void> {
    const [lon, lat] = fix.at;
    const pin: SavedPin = { id: newId(), kind: 'pin', name, added: Date.now(), lon, lat };
    await this.deps.save(pin);
    this.lastSaved = pin.id;
    this.toast(`Saved “${name}”`, true);
  }

  private async undo(): Promise<void> {
    const id = this.lastSaved;
    this.lastSaved = null;
    $('here-toast').hidden = true;
    if (id) await this.deps.remove(id).catch((err) => this.toast(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, false));
  }

  private name(fix: Fix): string {
    return this.deps.suggest(fix.at) ?? `Pin ${coordsText({ lon: fix.at[0], lat: fix.at[1] })}`;
  }

  private toast(text: string, canUndo: boolean): void {
    $('here-toast-text').textContent = text;
    $('here-undo').hidden = !canUndo;
    if (!canUndo) this.lastSaved = null;
    const el = $('here-toast');
    // Above the navigation panel or the route card when one is up, else where the card would be.
    const below = ['nav-bottom', 'route-card'].map((id) => $(id)).find((e) => e.offsetParent !== null);
    el.style.bottom = below ? `${document.body.clientHeight - below.getBoundingClientRect().top + 10}px` : '';
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      $('here-toast').hidden = true;
      this.lastSaved = null;
    }, TOAST_MS);
  }
}
