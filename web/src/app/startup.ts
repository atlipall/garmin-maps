import { BUILD } from '../buildInfo';
import { hasStoredData, loadStored, type Stored } from '../storage/store';
import { androidApp } from './diagnostics';
import { showImport } from './importScreen';
import { showUpdateNotice } from './updateNotice';
import { browserEnv, UpdateWatcher } from './updates';
import { startViewer } from './viewer';

export async function startApp(): Promise<void> {
  // In the Android app (made for car head units) a big screen gets car-sized controls (index.html).
  document.body.classList.toggle('android-app', androidApp() !== null);
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void new UpdateWatcher(BUILD, showUpdateNotice, browserEnv(new URL('./sw.js', document.baseURI))).start();
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
