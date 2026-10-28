import { storageName } from '../channel';
import { takenText, type Photo } from '../photos/photo';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A tap that moves less than this (px) and is this short (ms) is a tap, not a swipe. */
const TAP_PX = 10;
const TAP_MS = 300;
const SWIPE_PX = 60;
const DOUBLE_TAP_MS = 300;
const MAX_ZOOM = 5;

export interface ViewerDeps {
  /** The picture's address (an object URL), or null when it isn't here (yet). */
  picture: (id: string) => Promise<string | null>;
  thumb: (id: string) => Promise<string | null>;
  /** "Near Landmannalaugar" for a spot. */
  near: (lon: number, lat: number) => string | null;
  route: (p: Photo) => void;
  share: (p: Photo) => Promise<void>;
  /** Gets Share's file ready for the photo shown. */
  prepare: (p: Photo) => void;
  remove: (p: Photo) => void;
  describe: (p: Photo, text: string) => Promise<void>;
}

/** Descriptions started and not saved (Cancel keeps them): photo id → text. */
const DRAFTS = storageName('photoDrafts');
function drafts(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFTS) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function setDraft(id: string, text: string | null): void {
  const d = drafts();
  if (text === null) delete d[id];
  else d[id] = text;
  try {
    localStorage.setItem(DRAFTS, JSON.stringify(d));
  } catch {
    // not kept: the text is lost on Cancel, as without drafts
  }
}

/**
 * The photo viewer: the photo full screen on black with its details in a sheet; swipe sideways (or
 * the arrows, or the arrow keys) for the others in the group, down to close; tap for the photo
 * alone, pinch or double-tap to zoom. The description opens an editor sheet.
 */
export class PhotoViewer {
  private list: Photo[] = [];
  private index = 0;
  private url: string | null = null;
  private readonly el = $('photo-viewer');
  private readonly img = $<HTMLImageElement>('pv-img');
  /** Zoom and pan of the picture. */
  private z = { s: 1, x: 0, y: 0 };
  private lastFocus: HTMLElement | null = null;
  private editing: Photo | null = null;

  constructor(private readonly deps: ViewerDeps) {
    $('pv-close').onclick = () => this.close();
    $('pv-prev').onclick = () => this.step(-1);
    $('pv-next').onclick = () => this.step(1);
    $('pv-route').onclick = () => {
      const p = this.current;
      if (!p) return;
      this.close();
      deps.route(p);
    };
    $('pv-share').onclick = () => {
      const p = this.current;
      if (p) void deps.share(p).catch((err) => this.error(`Couldn't share: ${err instanceof Error ? err.message : String(err)}`));
    };
    $('pv-delete').onclick = () => {
      const p = this.current;
      if (p) deps.remove(p);
    };
    $('pv-desc').onclick = () => this.current && this.edit(this.current);
    // Keys while it's open, wherever focus is (it covers the whole screen).
    document.addEventListener('keydown', (e) => {
      if (!this.open || this.editing) return;
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowLeft') this.step(-1);
      else if (e.key === 'ArrowRight') this.step(1);
    });
    this.gestures();
    // The editor.
    $('pe-cancel').onclick = () => this.endEdit(false);
    $('photo-edit').addEventListener('submit', (e) => {
      e.preventDefault();
      this.endEdit(true);
    });
    $('photo-edit').addEventListener('keydown', (e) => e.key === 'Escape' && this.endEdit(false));
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  get current(): Photo | null {
    return this.list[this.index] ?? null;
  }

  /** Shows `list` (in order) from `start`. */
  show(list: Photo[], start = 0): void {
    if (!list.length) return;
    if (!this.open) this.lastFocus = document.activeElement as HTMLElement | null;
    this.list = list;
    this.el.hidden = false;
    this.el.classList.remove('bare');
    document.body.classList.add('photo-open');
    this.go(Math.max(0, Math.min(start, list.length - 1)));
    $('pv-close').focus();
  }

  close(): void {
    if (!this.open) return;
    this.el.hidden = true;
    document.body.classList.remove('photo-open');
    this.img.removeAttribute('src');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.list = [];
    this.lastFocus?.focus?.();
  }

  /** A photo changed (its description) or went: show the list as it now is. */
  update(p: Photo): void {
    const i = this.list.findIndex((x) => x.id === p.id);
    if (i < 0) return;
    this.list[i] = p;
    if (i === this.index) this.details();
  }

  /** `id` was deleted: on to the next one, or close when it was the last. */
  dropped(id: string): void {
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (!this.list.length) return this.close();
    this.go(Math.min(i, this.list.length - 1));
  }

  private step(d: number): void {
    const i = this.index + d;
    if (i >= 0 && i < this.list.length) this.go(i);
  }

  private go(i: number): void {
    this.index = i;
    this.resetZoom();
    this.details();
    this.error('');
    const p = this.list[i];
    this.deps.prepare(p);
    void this.deps.picture(p.id).then(async (url) => {
      if (this.current?.id !== p.id) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = url;
      // Not here yet (a synced photo still on its way): the thumbnail meanwhile.
      const src = url ?? (await this.deps.thumb(p.id));
      if (src) this.img.src = src;
      else this.img.removeAttribute('src');
      if (!url) this.error('This photo is still on its way from Google Drive.');
    });
  }

  private details(): void {
    const p = this.list[this.index];
    if (!p) return;
    const n = this.list.length;
    $('pv-count').textContent = n > 1 ? `${this.index + 1} of ${n}` : '';
    $<HTMLButtonElement>('pv-prev').disabled = this.index === 0;
    $<HTMLButtonElement>('pv-next').disabled = this.index === n - 1;
    $('pv-prev').hidden = $('pv-next').hidden = n < 2;
    $('pv-when').textContent = takenText(p.taken);
    const near = this.deps.near(p.lon, p.lat);
    $('pv-where').textContent = [near ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, p.alt !== null ? `${Math.round(p.alt)} m` : null].filter(Boolean).join(' · ');
    $('pv-camera').textContent = p.camera;
    const desc = $('pv-desc');
    desc.classList.toggle('empty', !p.description);
    $('pv-desc-text').textContent = p.description ?? '+ Add a description';
    desc.setAttribute('aria-label', p.description ? `Description: ${p.description}. Edit` : 'Add a description');
    this.img.alt = p.description ?? `Photo, ${takenText(p.taken)}`;
  }

  private error(text: string): void {
    $('pv-error').textContent = text;
  }

  // Zoom, pan, swipe and tap on the picture.
  private resetZoom(): void {
    this.z = { s: 1, x: 0, y: 0 };
    this.applyZoom();
  }

  private applyZoom(): void {
    const { s, x, y } = this.z;
    this.img.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
  }

  /** Zooms to `s` keeping the screen point (cx, cy) where it is. */
  private zoomAt(s: number, cx: number, cy: number): void {
    s = Math.max(1, Math.min(MAX_ZOOM, s));
    if (s === 1) return this.resetZoom();
    const r = this.img.getBoundingClientRect();
    // The image's own (unscaled) top-left on screen.
    const ox = r.left - this.z.x;
    const oy = r.top - this.z.y;
    const k = s / this.z.s;
    this.z = { s, x: cx - ox - (cx - ox - this.z.x) * k, y: cy - oy - (cy - oy - this.z.y) * k };
    this.applyZoom();
  }

  private gestures(): void {
    const stage = $('pv-stage');
    const pts = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; t: number; zx: number; zy: number } | null = null;
    let pinch: { d: number; s: number } | null = null;
    let lastTap = 0;
    let tapTimer = 0;
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) start = { x: e.clientX, y: e.clientY, t: Date.now(), zx: this.z.x, zy: this.z.y };
      if (pts.size === 2) {
        pinch = { d: dist(), s: this.z.s };
        start = null;
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.zoomAt(pinch.s * (dist() / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (start && this.z.s > 1) {
        this.z = { ...this.z, x: start.zx + e.clientX - start.x, y: start.zy + e.clientY - start.y };
        this.applyZoom();
      } else if (start) {
        // Follow the finger a little, so a swipe feels attached.
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        this.img.style.transform = Math.abs(dx) > Math.abs(dy) ? `translateX(${dx}px)` : dy > 0 ? `translateY(${dy}px)` : '';
      }
    });
    const end = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch) {
        if (pts.size < 2) pinch = null;
        return;
      }
      const s = start;
      start = null;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      const tap = Math.hypot(dx, dy) < TAP_PX && Date.now() - s.t < TAP_MS;
      if (this.z.s > 1 && !tap) return;
      this.applyZoom();
      if (tap) {
        // A double tap zooms in (or back out); a single one shows or hides the details.
        if (Date.now() - lastTap < DOUBLE_TAP_MS) {
          clearTimeout(tapTimer);
          lastTap = 0;
          if (this.z.s > 1) this.resetZoom();
          else this.zoomAt(2.5, e.clientX, e.clientY);
          return;
        }
        lastTap = Date.now();
        tapTimer = window.setTimeout(() => this.el.classList.toggle('bare'), DOUBLE_TAP_MS);
        return;
      }
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) this.step(dx < 0 ? 1 : -1);
      else if (dy > SWIPE_PX * 1.5 && dy > Math.abs(dx)) this.close();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  // The description editor.
  private edit(p: Photo): void {
    this.editing = p;
    const form = $('photo-edit');
    form.hidden = false;
    $('pe-when').textContent = takenText(p.taken);
    $('pe-where').textContent = this.deps.near(p.lon, p.lat) ?? '';
    void this.deps.thumb(p.id).then((u) => u && ($<HTMLImageElement>('pe-thumb').src = u));
    const text = $<HTMLTextAreaElement>('pe-text');
    text.value = drafts()[p.id] ?? p.description ?? '';
    text.focus();
  }

  private endEdit(save: boolean): void {
    const p = this.editing;
    if (!p) return;
    const text = $<HTMLTextAreaElement>('pe-text').value;
    this.editing = null;
    $('photo-edit').hidden = true;
    $('pv-desc').focus();
    if (save) {
      setDraft(p.id, null);
      void this.deps.describe(p, text.trim()).catch((err) => this.error(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      // Typed and cancelled: kept for next time, not lost.
      setDraft(p.id, text.trim() && text.trim() !== (p.description ?? '') ? text : null);
    }
  }
}
