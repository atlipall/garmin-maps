/** The part of the Screen Wake Lock API used here (navigator.wakeLock). */
export interface WakeLockApi {
  request(): Promise<{ release(): Promise<void> }>;
}

/** Page visibility, abstracted for tests. */
export interface Visibility {
  readonly visible: boolean;
  onVisibilityChange(fn: () => void): void;
}

/**
 * Keeps the screen from sleeping while `wanted`. The system drops the lock whenever the page is
 * hidden (another app, screen locked by hand), so it is requested again on return. Refusals
 * (Low Power Mode, older iOS Home Screen apps) are ignored: the screen then sleeps as usual.
 */
export class ScreenAwake {
  private wanted = false;
  private lock: { release(): Promise<void> } | null = null;
  private pending = false;

  constructor(private readonly api: WakeLockApi | null, private readonly doc: Visibility) {
    doc.onVisibilityChange(() => {
      if (!doc.visible) this.lock = null; // released by the system
      this.sync();
    });
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
      this.api.request().then((lock) => {
        this.pending = false;
        if (this.wanted && this.doc.visible) this.lock = lock;
        else lock.release().catch(() => {});
      }, () => {
        this.pending = false;
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
  });
}
