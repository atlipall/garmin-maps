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
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
