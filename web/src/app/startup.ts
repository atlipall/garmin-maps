import { hasStoredData, loadStored, type Stored } from '../storage/store';
import { showImport } from './importScreen';
import { startViewer } from './viewer';

export async function startApp(): Promise<void> {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register(new URL('./sw.js', document.baseURI)).catch((err) => console.warn('service worker', err));
  }
  let stored: Stored | null = null;
  try {
    stored = await loadStored();
  } catch (err) {
    console.error(err);
    return showImport(`Could not read the stored map: ${err instanceof Error ? err.message : String(err)}`, { hasMap: true });
  }
  // Leftover map data that doesn't form a loadable map can still be removed from the import screen.
  if (!stored) return showImport('', { hasMap: await hasStoredData().catch(() => false) });
  try {
    await startViewer(stored);
  } catch (err) {
    console.error(err);
    showImport(`Could not open the stored map: ${err instanceof Error ? err.message : String(err)}`, { hasMap: true });
  }
}
