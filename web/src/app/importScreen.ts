import { clearStored, importFiles, requestPersistence } from '../storage/store';

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
  const busy = (on: boolean) => [button, cancel, remove].forEach((b) => (b.disabled = on));
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

  button.onclick = async () => {
    const img = $<HTMLInputElement>('img-file').files?.[0];
    const hgt = [...($<HTMLInputElement>('hgt-files').files ?? [])];
    if (!img) {
      $('import-error').textContent = 'Pick the .img map file first.';
      return;
    }
    $('import-error').textContent = '';
    busy(true);
    try {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await importFiles(img, hgt, (m) => ($('import-progress').textContent = m));
      location.reload();
    } catch (err) {
      $('import-progress').textContent = '';
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      busy(false);
    }
  };
}
