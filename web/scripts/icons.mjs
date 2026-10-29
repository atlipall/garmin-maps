// Draws the app's icons from the SVGs in brand/ (the logo's master files): the web app's PNGs, the
// favicon, and the Android app's launcher icons for launchers older than adaptive icons. Run after
// changing the logo:
//   npm run icons
// Chrome draws them (the same one the e2e uses), so no image library is needed.
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ICONS = REPO + 'web/public/icons/';
const RES = REPO + 'android/app/src/main/res/';

/** [source SVG in brand/, size in px, output path] */
const PNGS = [
  // Square: the iPhone and Chrome round the corners themselves.
  ['varda-icon-square.svg', 192, ICONS + 'icon-192.png'],
  ['varda-icon-square.svg', 512, ICONS + 'icon-512.png'],
  ['varda-icon-square.svg', 180, ICONS + 'apple-touch-icon.png'],
  ['varda-icon-maskable.svg', 512, ICONS + 'icon-512-maskable.png'],
  // Older Android launchers show the icon as it is: rounded, with see-through corners.
  ['varda-icon.svg', 144, RES + 'mipmap-xxhdpi/ic_launcher.png'],
  ['varda-icon.svg', 192, RES + 'mipmap-xxxhdpi/ic_launcher.png'],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  for (const [svg, size, out] of PNGS) {
    const data = (await readFile(REPO + 'brand/' + svg)).toString('base64');
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => document.querySelector('img').complete);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`${svg} → ${out.slice(REPO.length)} (${size} px)`);
  }
} finally {
  await browser.close();
}
// The favicon stays a vector: sharp at every size and in every tab.
await copyFile(REPO + 'brand/varda-icon.svg', ICONS + 'favicon.svg');
console.log('varda-icon.svg → web/public/icons/favicon.svg');
