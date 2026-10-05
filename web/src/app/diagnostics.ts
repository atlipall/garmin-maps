import { versionLabel } from '../buildInfo';
import { DEV, storageName } from '../channel';

/**
 * ⋯ → Diagnostics: what the app sees on this device, for when something doesn't work on one (a
 * car's head unit) and there's no developer console to look in. It shows where the app runs, the
 * location permission, and a live location test with every fix and error as it comes; in the
 * Android app it opens the app's own log (its location service, Chrome's messages). "Copy" puts it
 * all on the clipboard.
 */

/** Things worth knowing that the app otherwise keeps quiet about (location errors), newest last. */
const notes: { time: number; text: string; times: number }[] = [];
const NOTES_KEEP = 40;

const clock = (t = Date.now()) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });

/** Notes something for the diagnostics panel (a repeat of the last note is counted instead). */
export function diag(text: string): void {
  const last = notes[notes.length - 1];
  if (last?.text === text) {
    last.times++;
    last.time = Date.now();
    return;
  }
  notes.push({ time: Date.now(), text, times: 1 });
  if (notes.length > NOTES_KEEP) notes.shift();
}

const APP_KEY = storageName('android-app');

/**
 * The Android app this page runs in (its package name), or null in a browser. Chrome tells a
 * Trusted Web Activity's page with the referrer (android-app://<package>/) on the first load only,
 * so it's remembered; the app's built-in browser says so in its user agent.
 */
export function androidApp(): string | null {
  const ua = /GarminMapApp\/([\w.]+)/.exec(navigator.userAgent);
  if (ua) return ua[1];
  const ref = /^android-app:\/\/([\w.]+)/.exec(document.referrer);
  try {
    if (ref) localStorage.setItem(APP_KEY, ref[1]);
    return ref?.[1] ?? localStorage.getItem(APP_KEY);
  } catch {
    return ref?.[1] ?? null;
  }
}

function runningIn(app: string | null): string {
  if (app) return `Android app ${app}, ${/GarminMapApp\//.test(navigator.userAgent) ? 'built-in browser' : 'in Chrome'}`;
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return standalone ? 'Home Screen app' : 'browser tab';
}

const ERRORS: Record<number, string> = { 1: 'permission denied', 2: 'position unavailable', 3: 'timed out' };

/** A geolocation error as text: what kind, and the browser's own words. */
export function describeError(err: GeolocationPositionError): string {
  return `error ${err.code} (${ERRORS[err.code] ?? 'unknown'})${err.message ? ': ' + err.message : ''}`;
}

export class DiagnosticsPanel {
  private watchId: number | null = null;
  private fixes = 0;
  /** The live test's lines, newest first. */
  private live: string[] = [];
  private permission = '…';

  constructor(
    private readonly el: HTMLElement,
    /** The app's own last fix (its locate button), if any. */
    private readonly lastFix: () => { accuracy: number; time: number } | null,
  ) {
    el.querySelector<HTMLButtonElement>('#diag-copy')!.onclick = () => void this.copy();
    el.querySelector<HTMLButtonElement>('#diag-test')!.onclick = () => (this.watchId === null ? this.startTest() : this.stopTest());
    const log = el.querySelector<HTMLButtonElement>('#diag-android')!;
    const app = androidApp();
    log.hidden = !app;
    // Opens the Android app's log screen (LogActivity), which listens for this link.
    log.onclick = () => app && (location.href = `intent://log#Intent;scheme=garminmap;package=${app};end`);
  }

  show(open: boolean): void {
    this.el.hidden = !open;
    if (!open) return this.stopTest();
    void this.readPermission();
    this.render();
    this.startTest();
  }

  private async readPermission(): Promise<void> {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      this.permission = status.state;
      status.onchange = () => {
        this.permission = status.state;
        this.render();
      };
    } catch (e) {
      this.permission = `can't tell (${(e as Error).message})`;
    }
    this.render();
  }

  private startTest(): void {
    if (this.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.add('no location service in this browser');
      return;
    }
    this.add('test started');
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        this.fixes++;
        const c = p.coords;
        this.add(`fix ${this.fixes}: ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} ±${Math.round(c.accuracy)} m` + (c.speed != null ? `, ${Math.round(c.speed * 3.6)} km/h` : '') + `, ${Math.round((Date.now() - p.timestamp) / 1000)} s old`);
      },
      (err) => this.add(describeError(err)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    this.render();
  }

  private stopTest(): void {
    if (this.watchId === null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.add('test stopped');
  }

  private add(line: string): void {
    this.live.unshift(`${clock()} ${line}`);
    this.live.length = Math.min(this.live.length, 30);
    this.render();
  }

  private text(): string {
    const fix = this.lastFix();
    return [
      `${DEV ? 'Development version · ' : ''}${versionLabel()}`,
      `Running as: ${runningIn(androidApp())}`,
      `Browser: ${navigator.userAgent}`,
      `Screen: ${innerWidth}×${innerHeight} at ${devicePixelRatio}x · ${navigator.onLine ? 'online' : 'offline'}`,
      '',
      `Location permission: ${this.permission}`,
      `The map's last fix: ${fix ? `${Math.round((Date.now() - fix.time) / 1000)} s ago, ±${Math.round(fix.accuracy)} m` : 'none'}`,
      '',
      `Location test (${this.watchId === null ? 'stopped' : `running, ${this.fixes} fix${this.fixes === 1 ? '' : 'es'}`}):`,
      ...(this.live.length ? this.live : ['(nothing yet)']),
      '',
      'Earlier:',
      ...(notes.length ? [...notes].reverse().map((n) => `${clock(n.time)} ${n.text}${n.times > 1 ? ` (×${n.times}, the last at this time)` : ''}`) : ['(nothing noted)']),
    ].join('\n');
  }

  private render(): void {
    if (this.el.hidden) return;
    this.el.querySelector('#diag-text')!.textContent = this.text();
    this.el.querySelector('#diag-test')!.textContent = this.watchId === null ? 'Test location' : 'Stop the test';
  }

  private async copy(): Promise<void> {
    const button = this.el.querySelector<HTMLButtonElement>('#diag-copy')!;
    try {
      await navigator.clipboard.writeText(this.text());
      button.textContent = 'Copied';
    } catch {
      button.textContent = "Couldn't copy";
    }
    setTimeout(() => (button.textContent = 'Copy'), 2000);
  }
}
