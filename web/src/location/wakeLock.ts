/** The part of the Screen Wake Lock API used here (navigator.wakeLock). */
export interface WakeLockApi {
  request(): Promise<Lock>;
}

/** A held lock; the system may release it on its own (`onRelease`). */
interface Lock {
  release(): Promise<void>;
  addEventListener?(type: 'release', fn: () => void): void;
}

/** Page visibility, abstracted for tests. */
export interface Visibility {
  readonly visible: boolean;
  onVisibilityChange(fn: () => void): void;
  /** Called on every touch or click (a request refused without one is tried again then). */
  onTouch?(fn: () => void): void;
}

/**
 * Keeps the screen from sleeping while `wanted`. The system drops the lock whenever the page is
 * hidden (another app, screen locked by hand), and sometimes on its own, so it is requested again
 * on return. A refusal (no tap yet when the app reopens with location on, Low Power Mode, older iOS
 * Home Screen apps) is tried again on the next touch; until then the screen sleeps as usual.
 */
export class ScreenAwake {
  private wanted = false;
  private lock: Lock | null = null;
  private pending = false;
  private refused = false;

  constructor(private readonly api: WakeLockApi | null, private readonly doc: Visibility) {
    doc.onVisibilityChange(() => {
      if (!doc.visible) this.lock = null; // released by the system
      this.sync();
    });
    doc.onTouch?.(() => {
      if (this.refused) this.sync();
    });
  }

  /** The screen is being kept on now. */
  get held(): boolean {
    return this.lock !== null;
  }

  get supported(): boolean {
    return this.api !== null;
  }

  setWanted(wanted: boolean): void {
    this.wanted = wanted;
    this.sync();
  }

  private sync(): void {
    if (!this.api) return;
    if (this.wanted && this.doc.visible && !this.lock && !this.pending) {
      this.pending = true;
      this.refused = false;
      this.api.request().then((lock) => {
        this.pending = false;
        if (this.wanted && this.doc.visible) {
          this.lock = lock;
          lock.addEventListener?.('release', () => {
            if (this.lock !== lock) return;
            this.lock = null;
            this.sync();
          });
        } else lock.release().catch(() => {});
      }, () => {
        this.pending = false;
        this.refused = true;
      });
    } else if (!this.wanted && this.lock) {
      const lock = this.lock;
      this.lock = null;
      lock.release().catch(() => {});
    }
  }
}

/** The browser's wake lock and page visibility, or a null API where unsupported. */
export function browserScreenAwake(): ScreenAwake {
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  return new ScreenAwake(wl ? { request: () => wl.request('screen') } : null, {
    get visible() {
      return document.visibilityState === 'visible';
    },
    onVisibilityChange: (fn) => document.addEventListener('visibilitychange', fn),
    onTouch: (fn) => document.addEventListener('pointerdown', fn, { capture: true, passive: true }),
  });
}
