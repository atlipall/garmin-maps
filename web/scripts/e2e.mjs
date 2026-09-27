import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA = REPO + 'GPSmap.is 2024.21 Android/';
const IMG = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
const HGT_DIR = DATA + 'HILLSHADE - Add content to DEM folder/';
const OUT = REPO + 'out/web-samples/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5198;

const fail = (msg) => {
  throw new Error(`E2E FAILED: ${msg}`);
};

await mkdir(OUT, { recursive: true });
const hgts = (await readdir(HGT_DIR)).filter((n) => n.endsWith('.hgt')).map((n) => HGT_DIR + n);
const server = await preview({ root: WEB, preview: { port: PORT, strictPort: true } });
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024 });
  page.on('console', (m) => ['error', 'warn'].includes(m.type()) && console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const waitReady = () => page.waitForFunction(() => window.__app?.ready === true, { timeout: 300_000 });

  // 1. first run: import screen
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#import:not([hidden])', { timeout: 30_000 });
  await (await page.$('#img-file')).uploadFile(IMG);
  await (await page.$('#hgt-files')).uploadFile(...hgts);
  const t0 = Date.now();
  await Promise.all([page.waitForNavigation({ timeout: 600_000 }), page.click('#import-button')]);
  console.log(`import took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await waitReady();

  // 2. screenshots with hillshade
  const samples = await page.evaluate(() => window.__app.samples);
  for (const s of samples) {
    await page.evaluate((c, z) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('idle timeout')), 120_000);
      window.__app.map.jumpTo({ center: c, zoom: z });
      window.__app.map.once('idle', () => { clearTimeout(t); resolve(); });
    }), s.center, s.zoom);
    await page.screenshot({ path: `${OUT}${s.name}-hillshade.png` });
    console.log('wrote', `${OUT}${s.name}-hillshade.png`);
  }
  console.log(await page.evaluate(() => window.__app.perf.summary()));

  // 3. search
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  const hit = await page.evaluate(() => window.__app.search('landmannalaugar')[0]);
  if (!hit || Math.abs(hit.lon + 19.06) > 0.1 || Math.abs(hit.lat - 63.99) > 0.1) fail(`search landmannalaugar → ${JSON.stringify(hit)}`);
  console.log('search ok:', hit.name, hit.lon.toFixed(3), hit.lat.toFixed(3));

  // 4. reload opens straight from storage
  await page.reload();
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('import screen shown after reload');
  console.log('reload from storage ok');

  // 5. offline reload
  await page.setOfflineMode(true);
  await page.reload();
  await waitReady();
  console.log('offline reload ok');

  // 6. re-import: "Load another map" must not delete anything; Cancel goes back to the stored map
  await page.setOfflineMode(false);
  const opfs = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name, h] of root.entries()) names.push(`${name}${h.kind === 'directory' ? '/' : ''}`);
    const pointer = names.includes('current.json') ? JSON.parse(await (await (await root.getFileHandle('current.json')).getFile()).text()) : null;
    return { names: names.sort(), pointer };
  });
  const before = await opfs();
  console.log('OPFS before re-import:', JSON.stringify(before));
  if (!before.pointer || !before.names.includes(`${before.pointer.dir}/`)) fail(`no committed map dir: ${JSON.stringify(before)}`);
  await page.click('#replace');
  await page.waitForSelector('#import:not([hidden])', { timeout: 30_000 });
  if (await page.$('#import-cancel[hidden]')) fail('Cancel button hidden on "Load another map"');
  if (await page.$('#remove-stored[hidden]')) fail('"Remove stored map" hidden while a map is stored');
  if (JSON.stringify(await opfs()) !== JSON.stringify(before)) fail('"Load another map" changed storage');
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click('#import-cancel')]);
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('import screen shown after Cancel');
  if (!(await page.evaluate(() => !!window.__app.map.getSource('dem')))) fail('hillshade missing after Cancel');
  console.log('cancel back to stored map ok');

  // 7. re-import the IMG only (no HGT): the new map replaces the old one, leaving one data dir
  await page.click('#replace');
  await page.waitForSelector('#import:not([hidden])', { timeout: 30_000 });
  await (await page.$('#img-file')).uploadFile(IMG);
  const t1 = Date.now();
  await Promise.all([page.waitForNavigation({ timeout: 600_000 }), page.click('#import-button')]);
  console.log(`re-import took ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('import screen shown after re-import');
  if (await page.evaluate(() => !!window.__app.map.getSource('dem'))) fail('hillshade still present after IMG-only re-import');
  const after = await opfs();
  console.log('OPFS after re-import:', JSON.stringify(after));
  const dataDirs = after.names.filter((n) => n.endsWith('/') && (n === 'garmin/' || n.startsWith('garmin-')));
  if (dataDirs.length !== 1 || dataDirs[0] !== `${after.pointer?.dir}/` || after.pointer.dir === before.pointer.dir) {
    fail(`expected exactly one new garmin-* data dir, got ${JSON.stringify(after)}`);
  }
  console.log('re-import ok:', dataDirs[0]);

  // 8. legacy layout (a map stored before versioned dirs: `garmin/`, no pointer) still loads, and
  //    the next import cleans it up. Let the running viewer finish its place index (which reads
  //    the map file and writes places.json) before its files are moved out from under it.
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  await page.evaluate(async (dir) => {
    const root = await navigator.storage.getDirectory();
    const src = await root.getDirectoryHandle(dir);
    const dst = await root.getDirectoryHandle('garmin', { create: true });
    for await (const [name, h] of src.entries()) {
      if (h.kind !== 'file') continue;
      const w = await (await dst.getFileHandle(name, { create: true })).createWritable();
      await w.write(await h.getFile());
      await w.close();
    }
    await root.removeEntry('current.json');
    await root.removeEntry(dir, { recursive: true });
  }, after.pointer.dir);
  await page.reload();
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('legacy garmin/ map not loaded');
  console.log('legacy layout loads:', JSON.stringify(await opfs()));
  await page.click('#replace');
  await page.waitForSelector('#import:not([hidden])', { timeout: 30_000 });
  await (await page.$('#img-file')).uploadFile(IMG);
  await Promise.all([page.waitForNavigation({ timeout: 600_000 }), page.click('#import-button')]);
  await waitReady();
  const migrated = await opfs();
  if (migrated.names.includes('garmin/') || migrated.names.filter((n) => n.startsWith('garmin-')).length !== 1) {
    fail(`legacy dir not cleaned up: ${JSON.stringify(migrated)}`);
  }
  console.log('legacy cleanup ok:', JSON.stringify(migrated));

  // 9. an empty (interrupted) pointer still resolves to the stored map
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const w = await (await root.getFileHandle('current.json')).createWritable();
    await w.truncate(0);
    await w.close();
  });
  await page.reload();
  await waitReady();
  if (await page.$('#import:not([hidden])')) fail('empty pointer lost the stored map');
  console.log('empty pointer falls back ok');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
