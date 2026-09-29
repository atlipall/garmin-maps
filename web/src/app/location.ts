import * as maplibregl from 'maplibre-gl';
import { angleDelta, chooseHeading, smoothAngle } from '../location/heading';
import { compassReset, dragged, INITIAL, longPress, tap, type LocationState } from '../location/modes';

/** Fraction of each compass change applied per reading: damps sensor jitter without lagging. */
const HEADING_SMOOTHING = 0.3;
/** Heading-up rotation ignores changes smaller than this (degrees) and runs at most this often. */
const ROTATE_MIN_DEG = 3;
const ROTATE_MIN_MS = 250;
/** Hold the locate button this long (ms) to turn location off. */
const LONG_PRESS_MS = 600;
/** Starting or resuming following zooms in to at least this (≈ 100 m scale bar: paths and buildings). */
const FOLLOW_ZOOM = 16;
/** The height pill is refreshed once the position has moved this far (m). */
const HEIGHT_MIN_MOVE = 10;

export interface Fix {
  at: [number, number];
  accuracy: number;
  time: number;
}

const ICONS: Record<'off' | 'north' | 'heading' | 'paused', string> = {
  off: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>',
  north: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 11 21 3l-8 18-2-8z" fill="currentColor"/></svg>',
  paused: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 11 21 3l-8 18-2-8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  heading: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2 20 21l-8-5-8 5z" fill="currentColor"/></svg>',
};

const LABELS = {
  off: 'Show my location',
  north: 'Following, north up. Tap for heading up',
  heading: 'Following, heading up. Tap for north up',
  paused: 'Follow my location again',
};

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

/** Metres per CSS pixel at a latitude and zoom (512 px tiles). */
const metresPerPixel = (lat: number, zoom: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

/** Great-circle distance in metres (small distances). */
function distanceM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * 6371000;
}

/**
 * The locate button (bottom-right) and everything it drives: the position marker with its
 * accuracy circle and direction cone, following the position with north up or heading up
 * (see ../location/modes.ts), and the ground-height pill (bottom-left, above the scale).
 */
export class LocationControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private state: LocationState = INITIAL;
  private readonly container = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly marker: maplibregl.Marker;
  private readonly markerEl = document.createElement('div');
  private readonly accuracyEl = document.createElement('div');
  private readonly coneEl = document.createElement('div');
  private watchId: number | null = null;
  private fix: Fix | null = null;
  private gps: { heading: number | null; speed: number | null } = { heading: null, speed: null };
  private compass: { heading: number; time: number } | null = null;
  private heading: number | null = null;
  private lastRotate = 0;
  private heightAt: [number, number] | null = null;
  private pressTimer = 0;
  private longPressed = false;
  /** The next fix is the first since location was turned on: zoom in to it. */
  private firstFix = false;
  /** A zoom-in in progress: later follow moves (new fixes, heading turns) must keep aiming for it,
   *  or each new easeTo restarts from the half-finished zoom and the zoom-in stalls. */
  private targetZoom: number | null = null;

  /** `elevation` looks up the ground height (m) at a point, null when unknown. */
  constructor(private readonly elevation: (lon: number, lat: number) => Promise<number | null>, private readonly heightEl: HTMLElement) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button.type = 'button';
    this.button.className = 'locate-button';
    this.container.append(this.button);
    this.markerEl.className = 'you';
    this.accuracyEl.className = 'you-accuracy';
    this.coneEl.className = 'you-cone';
    const dot = document.createElement('div');
    dot.className = 'you-dot';
    this.markerEl.append(this.accuracyEl, this.coneEl, dot);
    this.marker = new maplibregl.Marker({ element: this.markerEl, rotationAlignment: 'map', pitchAlignment: 'map' });
    this.render();
  }

  /** Called whenever location turns on or off (following or paused counts as on). */
  onActiveChange: ((active: boolean) => void) | null = null;

  /** The latest position fix, if any. */
  get lastFix(): Fix | null {
    return this.fix;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    this.button.addEventListener('pointerdown', () => {
      this.longPressed = false;
      this.pressTimer = window.setTimeout(() => {
        this.longPressed = true;
        this.setState(longPress());
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) this.button.addEventListener(ev, () => clearTimeout(this.pressTimer));
    this.button.addEventListener('click', () => {
      if (this.longPressed) return; // the long press already turned location off
      // Turning location on or resuming after a drag zooms in; switching north/heading up keeps the zoom.
      const startsFollowing = this.state.mode === 'off' || this.state.paused;
      if (this.state.mode === 'off') {
        this.firstFix = true;
        this.start();
      }
      this.setState(tap(this.state), startsFollowing);
    });
    // A drag (or a rotate gesture) by the user pauses following; programmatic moves have no originalEvent.
    map.on('dragstart', () => this.setState(dragged(this.state)));
    map.on('rotatestart', (e: { originalEvent?: Event }) => {
      if (e.originalEvent && this.state.mode === 'heading') this.setState(dragged(this.state));
    });
    map.on('zoom', () => this.sizeAccuracy());
    // A zoom-in is done once reached; a pinch by the user overrides it.
    map.on('zoomend', () => {
      if (this.targetZoom !== null && Math.abs(map.getZoom() - this.targetZoom) < 0.01) this.targetZoom = null;
    });
    map.on('zoomstart', (e: { originalEvent?: Event }) => {
      if (e.originalEvent) this.targetZoom = null;
    });
    // The compass button returns to north up (it resets the bearing itself).
    map.getContainer().querySelector('.maplibregl-ctrl-compass')?.addEventListener('click', () => this.setState(compassReset(this.state)));
    return this.container;
  }

  onRemove(): void {
    this.stop();
    this.container.remove();
    this.map = null;
  }

  private setState(next: LocationState, zoomIn = false): void {
    const prev = this.state;
    this.state = next;
    if (next.mode === 'off' && prev.mode !== 'off') this.stop();
    if ((next.mode === 'off') !== (prev.mode === 'off')) this.onActiveChange?.(next.mode !== 'off');
    this.render();
    if (next.mode !== 'off' && !next.paused) this.follow(true, zoomIn);
  }

  private render(): void {
    const { mode, paused } = this.state;
    const look = mode === 'off' ? 'off' : paused ? 'paused' : mode;
    this.button.innerHTML = ICONS[look];
    this.button.dataset.state = look;
    this.button.title = LABELS[look];
    this.button.setAttribute('aria-label', LABELS[look]);
  }

  /** Starts GPS and compass. Called from the tap itself: iOS only grants compass access to a user gesture. */
  private start(): void {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> } | undefined;
    const listen = () => {
      const absolute = 'ondeviceorientationabsolute' in window;
      window.addEventListener(absolute ? 'deviceorientationabsolute' : 'deviceorientation', this.onOrientation as EventListener);
    };
    if (DOE?.requestPermission) DOE.requestPermission().then((r) => r === 'granted' && listen(), () => {});
    else listen();
    if (!('geolocation' in navigator)) return this.unavailable('This device has no location service.');
    this.watchId = navigator.geolocation.watchPosition(this.onPosition, this.onError, { enableHighAccuracy: true, maximumAge: 5000 });
  }

  private stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('deviceorientationabsolute', this.onOrientation as EventListener);
    window.removeEventListener('deviceorientation', this.onOrientation as EventListener);
    this.marker.remove();
    this.fix = null;
    this.compass = null;
    this.heading = null;
    this.heightAt = null;
    this.targetZoom = null;
    this.heightEl.hidden = true;
    this.button.classList.remove('unavailable');
  }

  private unavailable(message: string): void {
    const wasOn = this.state.mode !== 'off';
    this.stop();
    this.state = INITIAL;
    this.render();
    if (wasOn) this.onActiveChange?.(false);
    this.button.classList.add('unavailable');
    this.button.title = message;
  }

  private readonly onError = (err: GeolocationPositionError): void => {
    if (err.code === err.PERMISSION_DENIED) this.unavailable('Location access is off. Allow it in Settings → Safari → Location.');
    // Other errors (timeout, no signal) are transient: keep watching.
  };

  private readonly onPosition = (pos: GeolocationPosition): void => {
    const map = this.map;
    if (!map || this.state.mode === 'off') return;
    const at: [number, number] = [pos.coords.longitude, pos.coords.latitude];
    this.fix = { at, accuracy: pos.coords.accuracy, time: Date.now() };
    this.gps = { heading: pos.coords.heading, speed: pos.coords.speed };
    this.marker.setLngLat(at);
    if (!this.marker.getElement().isConnected) this.marker.addTo(map);
    this.sizeAccuracy();
    this.updateHeading();
    if (this.firstFix && !this.state.paused) {
      this.firstFix = false;
      this.targetZoom = Math.max(map.getZoom(), FOLLOW_ZOOM);
      map.easeTo({ center: at, zoom: this.targetZoom, bearing: this.state.mode === 'heading' ? (this.heading ?? 0) : 0, duration: 800 });
    } else {
      this.follow(false);
    }
    this.updateHeight(at);
  };

  private readonly onOrientation = (e: OrientationEvent): void => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iOS: clockwise from north
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha; // alpha is counter-clockwise
    if (h == null) return;
    // Headings are relative to the device's top; correct for a rotated screen.
    const angle = screen.orientation?.angle ?? 0;
    this.compass = { heading: (h + angle) % 360, time: Date.now() };
    this.updateHeading();
  };

  private updateHeading(): void {
    const next = chooseHeading({ compass: this.compass, gps: this.gps, now: Date.now() });
    this.coneEl.hidden = next == null;
    if (next == null) return;
    this.heading = smoothAngle(this.heading, next, this.compass ? HEADING_SMOOTHING : 1);
    this.marker.setRotation(this.heading);
    if (this.state.mode === 'heading' && !this.state.paused && this.map) {
      const now = Date.now();
      if (Math.abs(angleDelta(this.map.getBearing(), this.heading)) >= ROTATE_MIN_DEG && now - this.lastRotate >= ROTATE_MIN_MS) {
        this.lastRotate = now;
        this.follow(false);
      }
    }
  }

  /** Centres on the position (and turns the map in heading-up mode). `jump`: a mode change, animate
   *  longer. `zoomIn`: also zoom in to at least FOLLOW_ZOOM. */
  private follow(jump: boolean, zoomIn = false): void {
    const map = this.map;
    if (!map || !this.fix || this.state.mode === 'off' || this.state.paused) return;
    const bearing = this.state.mode === 'heading' ? (this.heading ?? map.getBearing()) : 0;
    if (zoomIn) this.targetZoom = Math.max(this.targetZoom ?? map.getZoom(), FOLLOW_ZOOM);
    const zoom = this.targetZoom ?? map.getZoom();
    map.easeTo({ center: this.fix.at, bearing, zoom, duration: jump ? 600 : 300, essential: true });
  }

  private sizeAccuracy(): void {
    if (!this.map || !this.fix) return;
    const px = Math.max(0, (2 * this.fix.accuracy) / metresPerPixel(this.fix.at[1], this.map.getZoom()));
    this.accuracyEl.style.width = this.accuracyEl.style.height = `${Math.min(px, 4000)}px`;
  }

  private updateHeight(at: [number, number]): void {
    if (this.heightAt && distanceM(this.heightAt, at) < HEIGHT_MIN_MOVE) return;
    this.heightAt = at;
    this.elevation(at[0], at[1]).then((m) => {
      if (this.state.mode === 'off') return;
      this.heightEl.hidden = m == null;
      if (m != null) this.heightEl.textContent = `▲ ${Math.round(m)} m`;
    }, () => {
      this.heightEl.hidden = true;
    });
  }
}

/** A plain control holding the height pill, stacked above the scale bar (bottom-left). */
export class HeightControl implements maplibregl.IControl {
  readonly element = document.createElement('div');
  constructor() {
    this.element.className = 'maplibregl-ctrl height-pill';
    this.element.hidden = true;
    this.element.setAttribute('role', 'status');
    this.element.title = 'Ground height at your position';
  }
  onAdd(): HTMLElement {
    return this.element;
  }
  onRemove(): void {
    this.element.remove();
  }
}
