import type { Build } from '../buildInfo';

/** Notices when a newer version of the app is installed, so the page can offer to reload into it.
 *
 *  The service worker (public/sw.js) installs a new version on its own: a deploy changes sw.js, the
 *  browser fetches it, and the new worker precaches every file before it takes over. So once it is
 *  in control, a reload loads the new version, with or without a connection. The browser checks when
 *  the app starts; an app left open (an iPhone Home Screen app can stay open for days) is checked
 *  again each time it comes back into view, if online. The build the worker holds is compared with
 *  the page's own. Offline, nothing is asked and nothing changes. */
/** How long to wait for the service worker to say which build it holds. */
const ASK_TIMEOUT_MS = 3000;
/** How long "Reload from the server" waits for a new version to install before reloading anyway. */
const INSTALL_WAIT_MS = 30_000;

/** What the browser's service worker registration tells (the parts the watcher uses). */
export interface Registration {
  update(): Promise<unknown>;
  /** A new version installing, or installed and waiting to take over. */
  installing?: unknown;
  waiting?: unknown;
}

/** What the watcher needs from the browser (the real one is `browserEnv()`; tests pass fakes). */
export interface UpdateEnv {
  /** Registers the service worker; null when there is none (unsupported, or it failed). */
  register(): Promise<Registration | null>;
  /** Which build the service worker in control holds; null if none is, or it doesn't say. */
  controllerBuild(): Promise<Build | null>;
  /** Calls `fn` when another service worker takes control. */
  onControllerChange(fn: () => void): void;
  online(): boolean;
  /** Calls `fn` when the app comes back into view. */
  onShown(fn: () => void): void;
  /** Loads the page again. */
  reload(): void;
}

/** A newer build than this page's is in control: true only for a newer one (a page loaded from the
 *  network can be newer than the worker still installing it). */
export function isNewer(theirs: Build | null, mine: Build): boolean {
  return !!theirs && theirs.version !== 'dev' && theirs.builtAt > mine.builtAt;
}

export class UpdateWatcher {
  private reg: Registration | null = null;
  private found = false;
  /** Called once each when another service worker next takes control. */
  private onTakeover: Array<() => void> = [];

  constructor(
    private readonly mine: Build,
    /** Called once, when a newer version is installed and ready (offline too). */
    private readonly onReady: (build: Build) => void,
    private readonly env: UpdateEnv,
  ) {}

  async start(): Promise<void> {
    this.reg = await this.env.register();
    if (!this.reg) return;
    this.env.onControllerChange(() => {
      const waiting = this.onTakeover;
      this.onTakeover = [];
      waiting.forEach((fn) => fn());
      void this.compare();
    });
    this.env.onShown(() => this.check());
    // A version installed earlier (while this page loaded from the cache, say) is ready now.
    await this.compare();
  }

  /** Asks the server for a newer service worker, when online. */
  check(): void {
    if (!this.reg || this.found || !this.env.online()) return;
    this.reg.update().catch(() => {}); // a dropped connection: try again next time
  }

  /** "Reload from the server": asks the server for a newer version, waits for it to install and take
   *  over if there is one, then reloads (the page itself loads from the network first, see sw.js).
   *  Offline it changes nothing and says so. */
  async reloadFromServer(): Promise<'offline' | 'reloading'> {
    if (!this.env.online()) return 'offline';
    if (this.reg) {
      const reg = this.reg;
      const takeover = new Promise<void>((resolve) => this.onTakeover.push(resolve));
      const asked = await reg.update().then(() => true, () => false);
      if (asked && (reg.installing || reg.waiting)) await Promise.race([takeover, new Promise((r) => setTimeout(r, INSTALL_WAIT_MS))]);
    }
    this.env.reload();
    return 'reloading';
  }

  private async compare(): Promise<void> {
    if (this.found) return;
    const theirs = await this.env.controllerBuild();
    if (this.found || !isNewer(theirs, this.mine)) return;
    this.found = true;
    this.onReady(theirs!);
  }
}

/** The browser's service worker at `url`, asked over a message port which build it holds. */
export function browserEnv(url: URL): UpdateEnv {
  const sw = navigator.serviceWorker;
  return {
    register: () => sw.register(url).catch((err) => {
      console.warn('service worker', err);
      return null;
    }),
    controllerBuild: () => new Promise((resolve) => {
      const worker = sw.controller;
      if (!worker) return resolve(null);
      const port = new MessageChannel();
      const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
      port.port1.onmessage = (e) => {
        clearTimeout(timer);
        const b = e.data as Build | null;
        resolve(b && typeof b.version === 'string' && typeof b.builtAt === 'string' ? b : null);
      };
      worker.postMessage({ type: 'build' }, [port.port2]);
    }),
    onControllerChange: (fn) => sw.addEventListener('controllerchange', fn),
    online: () => navigator.onLine,
    onShown: (fn) => document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fn();
    }),
    reload: () => location.reload(),
  };
}
