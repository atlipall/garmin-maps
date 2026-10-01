/** Build stamp injected by vite.config.ts (`define`): the commit and when it was built. */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export const APP_VERSION = __APP_VERSION__;
export const BUILD_TIME = __BUILD_TIME__;

/** The build stamp, the same for a page and the service worker built with it (see vite.config.ts). */
export interface Build {
  version: string;
  /** When it was built (ISO time, so newer sorts later). */
  builtAt: string;
}

export const BUILD: Build = { version: APP_VERSION, builtAt: BUILD_TIME };

/** "Version feeaa6c · 30 Sep 2026, 14:05" (the build time in the viewer's local time zone). */
export function versionLabel(version = APP_VERSION, builtAt = BUILD_TIME): string {
  const when = new Date(builtAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Version ${version} · ${when}`;
}
