/**
 * Which deployment this build is: the app (/garmin-maps/app/), or the development version
 * (/garmin-maps/app-dev/, built with VITE_CHANNEL=dev from the `dev` branch) for trying changes on
 * a phone before they ship. Both are on the same site, where browsers share storage, so the
 * development version keeps everything apart: its own database, settings, stored map, caches and
 * Drive sync file. A newer storage format in it can then never break the app.
 */
export const DEV = import.meta.env.VITE_CHANNEL === 'dev';

/** A storage name for this deployment: the app's own, or with "-dev" added in the development
 *  version. */
export const storageName = (name: string) => (DEV ? `${name}-dev` : name);

/** The development version's folder in the browser's file storage. Not named garmin-*: the app
 *  removes such folders as leftovers of earlier imports. */
const DEV_DIR = 'app-dev';

/** The file-storage folder holding this deployment's map: the root for the app, a folder of its
 *  own for the development version. */
export async function storageRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return DEV ? root.getDirectoryHandle(DEV_DIR, { create: true }) : root;
}
