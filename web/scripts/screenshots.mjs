import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const IMG = REPO + 'GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
const OUT = REPO + 'out/web-samples/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IDLE_TIMEOUT_MS = 120_000;

await mkdir(OUT, { recursive: true });
const server = await createServer({ root: WEB, server: { port: 5199, strictPort: true } });
await server.listen();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024 });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5199/');
  const input = await page.$('#file');
  await input.uploadFile(IMG);
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180_000 });
  const samples = await page.evaluate(() => window.__app.samples);
  for (const s of samples) {
    await page.evaluate(
      (c, z, timeoutMs) => new Promise((resolve, reject) => {
        const map = window.__app.map;
        const timer = setTimeout(
          () => reject(new Error(`idle timed out after ${timeoutMs}ms for ${JSON.stringify(c)} z${z}`)),
          timeoutMs,
        );
        map.jumpTo({ center: c, zoom: z });
        map.once('idle', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
      s.center, s.zoom, IDLE_TIMEOUT_MS,
    );
    await page.screenshot({ path: `${OUT}${s.name}.png` });
    console.log('wrote', `${OUT}${s.name}.png`);
  }
  console.log(await page.evaluate(() => window.__app.perf.summary()));
} finally {
  if (browser) await browser.close();
  await server.close();
}
