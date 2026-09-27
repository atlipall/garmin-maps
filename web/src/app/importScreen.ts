import { importFiles, requestPersistence } from '../storage/store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function showImport(error = ''): void {
  $('import').hidden = false;
  $('import-error').textContent = error;
  const button = $<HTMLButtonElement>('import-button');
  button.onclick = async () => {
    const img = $<HTMLInputElement>('img-file').files?.[0];
    const hgt = [...($<HTMLInputElement>('hgt-files').files ?? [])];
    if (!img) {
      $('import-error').textContent = 'Pick the .img map file first.';
      return;
    }
    $('import-error').textContent = '';
    button.disabled = true;
    try {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await importFiles(img, hgt, (m) => ($('import-progress').textContent = m));
      location.reload();
    } catch (err) {
      $('import-progress').textContent = '';
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      button.disabled = false;
    }
  };
}
