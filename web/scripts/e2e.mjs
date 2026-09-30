import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA = REPO + 'GPSmap.is 2024.21 Android/';
const IMG = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
const HGT_DIR = DATA + 'HILLSHADE - Add content to DEM folder/';
const OUT = WEB + 'e2e-output/';
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
  // The search bar: a magnifier that expands on tap and collapses when left empty.
  const bar = () => page.evaluate(() => ({ collapsed: document.getElementById('topbar').classList.contains('collapsed'), focused: document.activeElement?.id, width: Math.round(document.getElementById('topbar').getBoundingClientRect().width) }));
  let sb = await bar();
  if (!sb.collapsed || sb.width > 50) fail(`search bar not collapsed at start: ${JSON.stringify(sb)}`);
  await page.click('#search-open');
  await new Promise((r) => setTimeout(r, 300));
  sb = await bar();
  if (sb.collapsed || sb.focused !== 'search' || sb.width < 200) fail(`search bar did not expand and focus: ${JSON.stringify(sb)}`);
  await page.keyboard.type('hekla');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
  const mapBox = await page.$eval('#map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.75 }; });
  await page.mouse.click(mapBox.x, mapBox.y);
  if ((await bar()).collapsed) fail('search bar collapsed while it still had text');
  await page.click('#search-clear');
  await page.mouse.click(mapBox.x, mapBox.y);
  await new Promise((r) => setTimeout(r, 300));
  sb = await bar();
  if (!sb.collapsed) fail(`empty search bar did not collapse: ${JSON.stringify(sb)}`);
  console.log('search bar ok');

  // 3b. location: a simulated GPS fix at Landmannalaugar; follow, heading up, pause on drag, height
  await browser.defaultBrowserContext().overridePermissions(`http://localhost:${PORT}`, ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
  // Headless Chrome denies the screen wake lock unless granted (Safari grants it without a prompt).
  await (await browser.target().createCDPSession()).send('Browser.grantPermissions', { origin: `http://localhost:${PORT}`, permissions: ['wakeLockScreen', 'geolocation', 'sensors'] });
  await page.setGeolocation({ latitude: 63.9913, longitude: -19.0605, accuracy: 15 });
  const locState = () => page.$eval('.locate-button', (b) => b.dataset.state);
  // Count screen wake lock requests and whether the last lock is still held.
  await page.evaluate(() => {
    const wl = navigator.wakeLock;
    const request = wl.request.bind(wl);
    window.__wake = { requests: 0, last: null };
    wl.request = async (type) => { window.__wake.requests++; try { const l = await request(type); window.__wake.last = l; return l; } catch (e) { window.__wake.error = e.name + ': ' + e.message; throw e; } };
  });
  const wake = () => page.evaluate(() => ({ requests: window.__wake.requests, held: !!window.__wake.last && !window.__wake.last.released, error: window.__wake.error }));
  await page.click('.locate-button');
  await page.waitForSelector('.you', { timeout: 10_000 });
  // Phones often deliver a second fix right after the first; it must not stall the zoom-in.
  await new Promise((r) => setTimeout(r, 150));
  await page.setGeolocation({ latitude: 63.9913, longitude: -19.0605, accuracy: 10 });
  await page.waitForFunction(() => /^▲ \d+ m$/.test(document.querySelector('.height-pill')?.textContent ?? ''), { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 1200)); // let the first-fix zoom finish
  const loc = await page.evaluate(() => {
    const c = window.__app.map.getCenter();
    return { lon: c.lng, lat: c.lat, zoom: window.__app.map.getZoom(), height: document.querySelector('.height-pill').textContent };
  });
  if (Math.abs(loc.lon + 19.0605) > 0.001 || Math.abs(loc.lat - 63.9913) > 0.001 || loc.zoom < 16) fail(`follow did not centre and zoom in on the fix: ${JSON.stringify(loc)}`);
  const metres = Number(loc.height.replace(/\D/g, ''));
  if (metres < 500 || metres > 700) fail(`Landmannalaugar ground height ${loc.height}`);
  if ((await locState()) !== 'north') fail(`after one tap: ${await locState()}`);
  let w = await wake();
  if (w.requests !== 1 || !w.held) fail(`screen wake lock not held while locating: ${JSON.stringify(w)}`);
  await page.click('#menu-button');
  await page.click('#keep-awake'); // switch off: released
  await new Promise((r) => setTimeout(r, 200));
  w = await wake();
  if (w.held || (await page.$eval('#keep-awake', (b) => b.getAttribute('aria-checked'))) !== 'false') fail(`keep-awake off did not release: ${JSON.stringify(w)}`);
  await page.click('#keep-awake'); // back on: requested again
  await new Promise((r) => setTimeout(r, 200));
  w = await wake();
  if (w.requests !== 2 || !w.held) fail(`keep-awake on did not re-request: ${JSON.stringify(w)}`);
  await page.click('#menu-button');
  // A compass reading of 40° (alpha counts counter-clockwise): the cone shows, and heading-up turns the map.
  const compass = () => page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 320, beta: 0, gamma: 0, absolute: true })));
  await compass();
  if (await page.$eval('.you-cone', (c) => c.hidden)) fail('no direction cone after a compass reading');
  await page.click('.locate-button');
  if ((await locState()) !== 'heading') fail(`after two taps: ${await locState()}`);
  for (let i = 0; i < 8; i++) { await compass(); await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 900));
  const bearing = await page.evaluate(() => window.__app.map.getBearing());
  if (Math.abs(bearing - 40) > 3) fail(`heading-up bearing ${bearing}, expected ~40`);
  const box = await page.$eval('#map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.up();
  if ((await locState()) !== 'paused') fail(`after dragging: ${await locState()}`);
  await page.evaluate(() => window.__app.map.jumpTo({ zoom: 11 })); // zoomed out while paused
  await page.click('.locate-button');
  if ((await locState()) !== 'heading') fail(`resume after pause: ${await locState()}`);
  await new Promise((r) => setTimeout(r, 900));
  const resumedZoom = await page.evaluate(() => window.__app.map.getZoom());
  if (resumedZoom < 15.9) fail(`resuming did not zoom in: z${resumedZoom}`);
  // Driving at 90 km/h heading 40°: the follow zoom eases out to 13, heading-up follows the GPS
  // course, and the position sits low on the screen (look-ahead).
  const gps = await page.createCDPSession();
  const drive = async (i, speed) => {
    await gps.send('Emulation.setGeolocationOverride', { latitude: 63.9913 + i * 0.0003, longitude: -19.0605 + i * 0.0005, accuracy: 8, speed, heading: 40 });
    await new Promise((r) => setTimeout(r, 400));
  };
  for (let i = 1; i <= 8; i++) await drive(i, 25);
  await new Promise((r) => setTimeout(r, 1500));
  const car = await page.evaluate(() => {
    const m = window.__app.map;
    const you = document.querySelector('.you').getBoundingClientRect();
    const box = m.getContainer().getBoundingClientRect();
    return { zoom: m.getZoom(), bearing: m.getBearing(), y: (you.top - box.top) / box.height };
  });
  if (Math.abs(car.zoom - 13) > 0.05) fail(`driving follow zoom ${car.zoom.toFixed(2)}, expected 13`);
  if (Math.abs(car.bearing - 40) > 3) fail(`driving heading-up bearing ${car.bearing.toFixed(1)}, expected 40`);
  if (car.y < 0.65 || car.y > 0.75) fail(`heading-up position at ${car.y.toFixed(2)} of the height, expected ~0.7`);
  // Zooming by hand turns the speed zoom off until the next tap.
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY: -300 });
  await new Promise((r) => setTimeout(r, 800));
  const handZoom = await page.evaluate(() => window.__app.map.getZoom());
  for (let i = 9; i <= 12; i++) await drive(i, 1);
  await new Promise((r) => setTimeout(r, 800));
  const afterWalk = await page.evaluate(() => window.__app.map.getZoom());
  if (Math.abs(afterWalk - handZoom) > 0.05) fail(`speed zoom overrode a hand zoom: ${handZoom.toFixed(2)} -> ${afterWalk.toFixed(2)}`);
  console.log(`driving ok: z${car.zoom.toFixed(1)}, bearing ${car.bearing.toFixed(0)}, position at ${Math.round(car.y * 100)}%`);
  await new Promise((r) => setTimeout(r, 800)); // let the resume animation finish
  await page.screenshot({ path: `${OUT}location.png` });
  console.log('location ok:', loc.height);

  // 3c. GPX: import a track without heights (climb comes from the elevation files) and a bad file
  const pts = Array.from({ length: 30 }, (_, i) => [63.9913 - i * 0.0006, -19.0605 - i * 0.0009]);
  const gpxPath = `${OUT}laugavegur-start.gpx`;
  const badPath = `${OUT}not-a-track.gpx`;
  await writeFile(gpxPath, `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Laugavegur start</name></metadata>
    <wpt lat="63.9913" lon="-19.0605"><name>Hut</name></wpt><trk><trkseg>${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')}</trkseg></trk></gpx>`);
  await writeFile(badPath, '<kml></kml>');
  await page.click('#menu-button');
  const mapName = await page.$eval('#map-name', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  if (!mapName.includes('Iceland GPSmap.is 2024.21 Detailed') || !mapName.includes('48 elevation files')) fail(`menu map name: ${mapName}`);
  const version = await page.$eval('#app-version', (e) => e.textContent);
  if (!/^Version [0-9a-f]{7} · \d{1,2} \w+ \d{4}, \d\d:\d\d$/.test(version)) fail(`menu version: ${version}`);
  console.log('version ok:', version);
  await page.click('#tracks-open');
  await (await page.$('#gpx-file')).uploadFile(gpxPath, badPath);
  await page.waitForFunction(() => document.querySelectorAll('#track-list .track').length === 1, { timeout: 10_000 });
  const err = await page.$eval('#tracks-error', (e) => e.textContent);
  if (!/not-a-track\.gpx: not a GPX file/.test(err)) fail(`bad GPX error: ${err}`);
  await page.waitForFunction(() => /↑ \d/.test(document.querySelector('#track-list .stats')?.textContent ?? ''), { timeout: 15_000 });
  const trk = await page.evaluate(() => ({
    stats: document.querySelector('#track-list .stats').textContent,
    features: window.__app.map.getStyle().sources.gpx.data.features.length,
  }));
  if (trk.features !== 2) fail(`GPX features on the map: ${trk.features}`);
  await new Promise((r) => setTimeout(r, 1000)); // fitBounds
  await page.screenshot({ path: `${OUT}tracks.png` });
  console.log('gpx ok:', trk.stats);
  await page.click('#tracks-close');

  // 3d. Routing: right-click drops a pin, a tap closes it; Ctrl+Click keeps it; Route here → panel
  // numbers; the switch; an off-road destination; a start chosen on the map; ×
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.06, 63.99], zoom: 12 }); m.once('idle', r); }));
  await gps.send('Emulation.setGeolocationOverride', { latitude: 63.936, longitude: -21.0, accuracy: 10 }); // Selfoss
  // The empty search box says how to pick any place.
  const hint = await page.evaluate(() => {
    document.querySelector('#topbar').classList.remove('collapsed');
    const input = document.querySelector('#search');
    input.focus();
    const h = document.querySelector('#search-hint');
    const shown = { hidden: h.hidden, text: h.textContent };
    input.blur();
    return { ...shown, hiddenAfterBlur: h.hidden };
  });
  if (hint.hidden || hint.text !== 'Right-click the map (Ctrl+Click on a Mac) to pick any place' || !hint.hiddenAfterBlur) fail(`search hint: ${JSON.stringify(hint)}`);
  // Right-click (the Mac's long press) drops a pin with a "Route here" card; a plain click closes it.
  const markers = () => page.evaluate(() => document.querySelectorAll('.maplibregl-marker').length);
  const markersBefore = await markers();
  await page.mouse.click(600, 500, { button: 'right' });
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('no card after right-click'));
  const dropped = await page.evaluate(() => ({ title: document.querySelector('#route-title').textContent, go: document.querySelector('#route-go').hidden ? '' : document.querySelector('#route-go').textContent, from: document.querySelector('#route-from-text').textContent }));
  if (!/^Dropped pin · 6\d\.\d{4}, -1\d\.\d{4}$/.test(dropped.title) || dropped.go !== 'Route here' || dropped.from !== 'From your position') fail(`dropped pin card: ${JSON.stringify(dropped)}`);
  await page.mouse.click(400, 400);
  await page.waitForFunction(() => document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('a map tap did not close the dropped-pin card'));
  if ((await markers()) !== markersBefore) fail('a map tap did not remove the dropped pin');
  // Ctrl+Click (a Mac trackpad's right-click: contextmenu, then click) drops a pin that stays.
  await page.keyboard.down('Control');
  await page.mouse.click(600, 500);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('no card after Ctrl+Click'));
  await new Promise((r) => setTimeout(r, 500));
  if (await page.$eval('#route-card', (e) => e.hidden)) fail('the click of a Ctrl+Click closed its own card');
  if ((await markers()) !== markersBefore + 1) fail('Ctrl+Click: the dropped pin is gone');
  await page.click('#route-close');
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  const withF = await page.$eval('#route-info', (e) => e.textContent);
  if (!/^1[2-5]\d km · [23] h/.test(withF)) fail(`Selfoss → Landmannalaugar: ${withF}`);
  const routeKinds = () => page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.map((f) => `${f.properties.kind}:${f.geometry.type}`));
  const kinds = await routeKinds();
  if (!kinds.includes('route:LineString') || !kinds.includes('start:Point') || kinds.some((k) => !/^(route:LineString|start:Point|offroad:LineString)$/.test(k))) fail(`route features: ${kinds}`);
  await new Promise((r) => setTimeout(r, 1500)); // fitBounds
  await page.screenshot({ path: `${OUT}route.png` });
  console.log('wrote', `${OUT}route.png`);
  // On a phone the card spans the width and sits above the height pill, scale and locate button.
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 1500));
  const phone = await page.evaluate(() => {
    const card = document.querySelector('#route-card').getBoundingClientRect();
    const tops = [...document.querySelectorAll('.maplibregl-ctrl-bottom-left > *, .maplibregl-ctrl-bottom-right > *')].filter((e) => !e.hidden && e.offsetHeight).map((e) => e.getBoundingClientRect().top);
    return { left: card.left, right: card.right, bottom: card.bottom, controlsTop: Math.min(...tops) };
  });
  await page.screenshot({ path: `${OUT}route-phone.png` });
  if (phone.bottom > phone.controlsTop - 4 || phone.left > 12 || phone.right < 378) fail(`route card on a phone: ${JSON.stringify(phone)}`);
  await page.setViewport({ width: 1024, height: 1024 });
  // Once a route is shown, a map tap leaves it (only × clears it).
  await page.mouse.click(400, 400);
  await new Promise((r) => setTimeout(r, 500));
  if (await page.$eval('#route-card', (e) => e.hidden)) fail('a map tap cleared the shown route');
  // Moving (GPS speed above walking pace) minimizes the card to one line; opened again by hand it
  // stays open; the chevron minimizes and opens it too.
  const isMin = () => page.$eval('#route-card', (e) => e.classList.contains('min'));
  const fixAt = (dLat, speed) => gps.send('Emulation.setGeolocationOverride', { latitude: 63.936 + dLat, longitude: -21.0, accuracy: 10, speed });
  await fixAt(0.0002, 10);
  await page.waitForFunction(() => document.querySelector('#route-card').classList.contains('min'), { timeout: 5_000 }).catch(() => fail('moving did not minimize the route card'));
  const minCard = await page.evaluate(() => ({ h: Math.round(document.querySelector('#route-card').getBoundingClientRect().height), text: `${document.querySelector('#route-title').textContent} | ${document.querySelector('#route-info').textContent}`, sep: getComputedStyle(document.querySelector('#route-info'), '::before').content }));
  if (minCard.h > 60 || !/^To Landmannalaugar \| 1\d\d km · \d h \d+ min$/.test(minCard.text) || minCard.sep !== '"· "') fail(`minimized card: ${JSON.stringify(minCard)}`);
  await page.screenshot({ path: `${OUT}route-min.png` });
  await page.click('#route-title');
  if (await isMin()) fail('tapping the minimized card did not open it');
  await fixAt(0.0004, 10);
  await new Promise((r) => setTimeout(r, 500));
  if (await isMin()) fail('the card, opened by hand, was minimized again while moving');
  await page.click('#route-min');
  if (!(await isMin())) fail('the chevron did not minimize the card');
  await page.click('#route-min');
  if (await isMin()) fail('the chevron did not open the card');
  // Standing still again (the speed is smoothed over fixes), back at the start position.
  for (const d of [0.0003, 0.0001, 0.0002, 0.0001, 0]) await fixAt(d, 0);
  await new Promise((r) => setTimeout(r, 300));
  console.log('route card minimize ok:', minCard.text);
  await page.click('#route-froads');
  if (await page.$eval('#route-prefer-switch', (e) => !e.hidden)) fail('"Prefer F-roads" shown with F-roads not allowed');
  const noRoute = () => page.waitForFunction(() => /No route without F-roads/.test(document.querySelector('#route-msg')?.textContent ?? ''), { timeout: 30_000 });
  await noRoute();
  // No route on the map: a new place replaces the card without asking.
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Hekla', lon: -19.67, lat: 63.99 }));
  const afterFail = await page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, title: document.querySelector('#route-title').textContent }));
  if (afterFail.confirm || afterFail.title !== 'Hekla') fail(`new place after a failed route: ${JSON.stringify(afterFail)}`);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await noRoute();
  await page.click('#route-froads'); // back on
  if (await page.$eval('#route-prefer-switch', (e) => e.hidden)) fail('"Prefer F-roads" hidden with F-roads allowed');
  // Preferring F-roads plans the route again (the time shown is still the real driving time).
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  await page.click('#route-prefer');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(() => fail('no route with F-roads preferred'));
  console.log('prefer F-roads ok:', await page.$eval('#route-info', (e) => e.textContent));
  await page.click('#route-prefer'); // off again (the setting is remembered)
  // With a route shown, a new pin asks first: Keep route leaves it; Clear route drops the pin.
  const confirmState = () => page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, drawn: window.__app.map.getStyle().sources.route.data.features.length, title: document.querySelector('#route-title').textContent, markers: document.querySelectorAll('.maplibregl-marker').length }));
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  const drawnBefore = (await confirmState()).drawn;
  if (!drawnBefore) fail('no route drawn before the pin-over-route check');
  const markersWithRoute = await markers();
  await page.mouse.click(600, 500, { button: 'right' });
  let cs = await confirmState();
  const question = await page.$eval('#route-confirm-text', (e) => e.textContent);
  if (question !== 'Drop a pin here and clear the current route?') fail(`confirm question: ${question}`);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Hekla', lon: -19.67, lat: 63.99 }));
  const named = await page.$eval('#route-confirm-text', (e) => e.textContent);
  if (named !== 'Drop a pin at Hekla and clear the current route?') fail(`confirm question for a named place: ${named}`);
  await page.click('#route-confirm-no');
  await page.mouse.click(600, 500, { button: 'right' });
  cs = await confirmState();
  if (!cs.confirm || cs.drawn !== drawnBefore || cs.title !== 'To Landmannalaugar' || cs.markers !== markersWithRoute + 1) fail(`pin over a route: ${JSON.stringify(cs)}`);
  await page.click('#route-confirm-no');
  cs = await confirmState();
  if (cs.confirm || cs.drawn !== drawnBefore || cs.markers !== markersWithRoute) fail(`Keep route: ${JSON.stringify(cs)}`);
  await page.mouse.click(600, 500, { button: 'right' });
  await page.click('#route-confirm-yes');
  cs = await confirmState();
  if (cs.confirm || cs.drawn !== 0 || !/^Dropped pin/.test(cs.title) || await page.$eval('#route-go', (e) => e.hidden)) fail(`Clear route: ${JSON.stringify(cs)}`);
  console.log('pin-over-route confirm ok');
  // A destination 1.5 km from the nearest road (a highland spot from a user report): a dashed
  // off-road leg and a "+ … off-road at the end" line.
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Off the road', lon: -19.31, lat: 64.18 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(async () => fail(`off-road destination: ${await page.$eval('#route-msg', (e) => e.textContent)}`));
  const off = await page.evaluate(() => ({ text: document.querySelector('#route-off').textContent, legs: window.__app.map.getStyle().sources.route.data.features.filter((f) => f.properties.kind === 'offroad').length, dashed: !!window.__app.map.getPaintProperty('route-offroad', 'line-dasharray') }));
  // (The emulated Selfoss position is ~40 m off its road too: "+ 40 m and 1.6 km … at the start and end".)
  if (!/^\+ (\d+ m and )?1\.\d km off-road at the (start and )?end$/.test(off.text) || off.legs < 1 || !off.dashed) fail(`off-road leg: ${JSON.stringify(off)}`);
  await new Promise((r) => setTimeout(r, 1000)); // fitBounds
  await page.screenshot({ path: `${OUT}route-offroad.png` });
  console.log('off-road ok:', off.text);
  // Change → Choose on the map → a map tap sets the start (a start pin, no start dot).
  await page.click('#route-change');
  const choices = await page.evaluate(() => [...document.querySelectorAll('#route-choices button')].map((b) => b.textContent));
  if (choices.join('|') !== 'Use my location|Choose on the map') fail(`start choices: ${choices}`);
  await page.click('#route-choose');
  const prompt = await page.$eval('#route-info', (e) => e.textContent);
  if (prompt !== "Tap the map where you'll start") fail(`choose-on-map prompt: ${prompt}`);
  if ((await routeKinds()).length) fail('the previous route is still drawn while choosing a start');
  await page.mouse.click(420, 360);
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? '') || document.querySelector('#route-msg')?.textContent, { timeout: 60_000 });
  const chosen = await page.evaluate(() => ({
    info: document.querySelector('#route-info').textContent,
    msg: document.querySelector('#route-msg').textContent,
    from: document.querySelector('#route-from-text').textContent,
    pins: document.querySelectorAll('.start-pin').length,
  }));
  const chosenKinds = await routeKinds();
  if (!/^\d+ km · .*min$/.test(chosen.info) || chosen.from !== 'From the chosen point' || chosen.pins !== 1 || chosenKinds.includes('start:Point')) fail(`chosen start: ${JSON.stringify(chosen)} ${chosenKinds}`);
  console.log('start ok:', chosen.info);
  // With a route, × asks first: Keep route leaves everything; Clear route closes the card.
  await page.click('#route-close');
  const closeAsk = await page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, text: document.querySelector('#route-confirm-text').textContent, drawn: window.__app.map.getStyle().sources.route.data.features.length }));
  if (!closeAsk.confirm || closeAsk.text !== 'Clear the current route?' || !closeAsk.drawn) fail(`× with a route: ${JSON.stringify(closeAsk)}`);
  await page.click('#route-confirm-no');
  if (await page.$eval('#route-card', (e) => e.hidden) || !(await page.$eval('#route-confirm', (e) => e.hidden)) || !(await page.$('.start-pin'))) fail('Keep route after × did not keep the route');
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  if (await page.$eval('#route-card', (e) => !e.hidden)) fail('route card still open after ×');
  if (await page.$('.start-pin')) fail('start pin still shown after ×');
  console.log('routing ok:', withF);

  // 4. reload opens straight from storage, where the app was: view, location mode and route
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.5, 64.05], zoom: 9.5, bearing: 0 }); m.once('idle', r); }));
  await new Promise((r) => setTimeout(r, 800)); // the save waits for the map to settle
  const was = await page.evaluate(() => ({ locate: document.querySelector('.locate-button').dataset.state }));
  await page.reload();
  await waitReady();
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(() => fail('route not restored after reload'));
  const now = await page.evaluate(() => {
    const m = window.__app.map;
    return { title: document.querySelector('#route-title').textContent, center: m.getCenter().toArray(), zoom: m.getZoom(), locate: document.querySelector('.locate-button').dataset.state, drawn: m.getStyle().sources.route.data.features.length };
  });
  console.log('restored:', JSON.stringify({ was, now }));
  if (now.title !== 'To Landmannalaugar' || !now.drawn || now.locate !== was.locate) fail(`restore after reload: ${JSON.stringify({ was, now })}`);
  // Without location on, the view is exactly as left (following would move it to the position).
  if (was.locate === 'off' && (Math.abs(now.center[0] + 19.5) > 0.001 || Math.abs(now.center[1] - 64.05) > 0.001 || Math.abs(now.zoom - 9.5) > 0.01)) fail(`view not restored: ${JSON.stringify(now)}`);
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  console.log('restore after reload ok');
  if (await page.$('#import:not([hidden])')) fail('import screen shown after reload');
  await page.waitForFunction(() => window.__app?.tracks?.count === 1, { timeout: 10_000 }).catch(() => fail('GPX track not kept across reload'));
  // Deleting asks for a second tap.
  await page.click('#menu-button');
  await page.click('#tracks-open');
  await page.click('.track-delete');
  if ((await page.evaluate(() => window.__app.tracks.count)) !== 1) fail('deleted a track without confirmation');
  await page.click('.track-delete');
  await page.waitForFunction(() => window.__app.tracks.count === 0 && !document.querySelector('#track-list .track'), { timeout: 5_000 }).catch(() => fail('track not deleted'));
  await page.click('#tracks-close');
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
  await page.click('#menu-button');
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
  await page.click('#menu-button');
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
  await page.click('#menu-button');
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
