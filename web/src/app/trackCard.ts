import { gpxFileName, shareFile, trackGpx } from '../gpx/export';
import { formatDistance, formatStats } from '../gpx/stats';
import type { StoredTrack } from '../gpx/store';
import { nearestAhead, trackLine } from '../tracks/plan';
import type { Fix } from './location';
import { ON_TRACK_M, type TrackNav } from './trackNav';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * A track's card (a tap on it in the Tracks panel): its length and climb, how far you are from it,
 * Navigate (to its nearest point, then along it), Reverse (follow it the other way) and Export GPX.
 * Shown in the route card's place, which waits meanwhile.
 */
export class TrackCard {
  private track: StoredTrack | null = null;
  private reverse = false;

  constructor(private readonly nav: TrackNav, private readonly fix: () => Fix | null) {
    $('track-card-close').onclick = () => this.close();
    $('track-reverse').onclick = () => {
      this.reverse = !this.reverse;
      this.render();
    };
    $('track-export').onclick = () => {
      const t = this.track;
      if (t) void shareFile(gpxFileName(t.name), trackGpx(t.gpx, t.name)).catch((err) => this.note(`Couldn't export: ${err instanceof Error ? err.message : String(err)}`));
    };
    $('track-navigate').onclick = () => void this.navigate();
  }

  open(t: StoredTrack): void {
    this.track = t;
    this.reverse = false;
    $('track-card').hidden = false;
    document.body.classList.add('track-card-open');
    this.render();
  }

  close(): void {
    this.track = null;
    $('track-card').hidden = true;
    document.body.classList.remove('track-card-open');
  }

  /** A track renamed in the list: the card shows the new name if it's this track's. */
  renamed(t: StoredTrack): void {
    if (this.track?.id === t.id) $('track-card-title').textContent = t.name;
  }

  /** The track shown (for tests). */
  get shown(): StoredTrack | null {
    return this.track;
  }

  private render(): void {
    const t = this.track;
    if (!t) return;
    $('track-card-swatch').style.backgroundColor = t.color;
    $('track-card-title').textContent = t.name;
    $('track-card-stats').textContent = `${formatStats(t.stats)} · ${t.route ? 'saved route' : 'imported GPX'}`;
    const rev = $('track-reverse');
    rev.setAttribute('aria-pressed', String(this.reverse));
    rev.textContent = this.reverse ? 'Reversed' : 'Reverse';
    const fix = this.fix();
    const way = this.reverse ? ' (from its end)' : '';
    if (!fix) return this.note(`Navigation starts at the beginning of the track${way}; turn location on to start from where you are.`);
    const off = nearestAhead(trackLine(t, this.reverse), fix.at).off;
    this.note(off <= ON_TRACK_M ? `You're on the track: navigation follows it from here${way}.` : `You're ${formatDistance(off)} from the track: navigation takes you to its nearest point, then along it${way}.`);
  }

  private note(text: string): void {
    $('track-card-note').textContent = text;
  }

  private async navigate(): Promise<void> {
    const t = this.track;
    if (!t) return;
    const button = $<HTMLButtonElement>('track-navigate');
    button.disabled = true;
    if (!t.route || this.reverse) this.note('Matching the track to the roads…');
    try {
      await this.nav.start(t, this.reverse);
      this.close();
    } catch (err) {
      this.note(`Couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      button.disabled = false;
    }
  }
}
