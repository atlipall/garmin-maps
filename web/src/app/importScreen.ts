import { clearStored, downloadMap, importFiles, requestPersistence } from '../storage/store';

/** The free OpenStreetMap-based map of Iceland, through the download pass-through (web/download-worker). */
export const FREE_MAP_URL = 'https://garmin-maps-download.atlipall.workers.dev/iceland.zip';
const FREE_MAP_NAME = 'Freizeitkarte Iceland (OpenStreetMap).img';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ImportOptions {
  /** A map is stored: offer to remove it (e.g. to free space for a large import). */
  hasMap?: boolean;
  /** The viewer is behind this screen: offer to go back to it (a reload into the stored map). */
  canCancel?: boolean;
}

const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

export function showImport(error = '', opts: ImportOptions = {}): void {
  $('import').hidden = false;
  $('import-error').textContent = error;
  $('import-progress').textContent = '';
  $('home-hint').hidden = isStandalone();

  const button = $<HTMLButtonElement>('import-button');
  const cancel = $<HTMLButtonElement>('import-cancel');
  const remove = $<HTMLButtonElement>('remove-stored');
  const download = $<HTMLButtonElement>('download-free');
  const busy = (on: boolean) => [button, cancel, remove, download].forEach((b) => (b.disabled = on));
  busy(false);

  cancel.hidden = !opts.canCancel;
  cancel.onclick = () => location.reload();

  remove.hidden = !opts.hasMap;
  remove.onclick = async () => {
    if (!confirm('Remove the stored map from this device? You will need the map files to import it again.')) return;
    busy(true);
    try {
      await clearStored();
      location.reload();
    } catch (err) {
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      busy(false);
    }
  };

  /** Stores a map (`store` reports progress), then reloads into it; shows the error otherwise. */
  const run = async (store: (onProgress: (m: string) => void) => Promise<void>) => {
    $('import-error').textContent = '';
    busy(true);
    try {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await store((m) => ($('import-progress').textContent = m));
      location.reload();
    } catch (err) {
      $('import-progress').textContent = '';
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      busy(false);
    }
  };

  button.onclick = () => {
    const img = $<HTMLInputElement>('img-file').files?.[0];
    const hgt = [...($<HTMLInputElement>('hgt-files').files ?? [])];
    if (!img) {
      $('import-error').textContent = 'Pick the .img map file first.';
      return;
    }
    void run((onProgress) => importFiles(img, hgt, onProgress));
  };

  download.onclick = () => {
    if (!navigator.onLine) {
      $('import-error').textContent = 'You are offline. Connect to the internet to download the map.';
      return;
    }
    void run((onProgress) => downloadMap(FREE_MAP_URL, FREE_MAP_NAME, onProgress));
  };
}
