import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { createMap } from './lib/renderer.mjs';
import { metatiles } from './lib/tiles.mjs';
import { openReader, openWriter } from './lib/mbtiles.mjs';

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string' }, vector: { type: 'string' }, dem: { type: 'string' },
    sprite: { type: 'string' }, fonts: { type: 'string' }, out: { type: 'string' },
    minzoom: { type: 'string', default: '5' }, maxzoom: { type: 'string', default: '15' },
    workers: { type: 'string', default: String(Math.max(1, os.cpus().length - 2)) },
    metatile: { type: 'string', default: '8' }, buffer: { type: 'string', default: '256' },
    format: { type: 'string', default: 'png' },
    center: { type: 'string' }, zoom: { type: 'string' }, size: { type: 'string', default: '1024' },
  },
});

const sources = { style: opts.style, vector: opts.vector, dem: opts.dem, sprite: opts.sprite, fonts: opts.fonts };

async function sample() {
  const [lon, lat] = opts.center.split(',').map(Number);
  const size = Number(opts.size);
  const map = createMap(sources);
  const view = { zoom: Number(opts.zoom) - 1, center: [lon, lat], width: size, height: size };
  const raw = await map.render(view);
  await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toFile(opts.out);
  map.release();
  console.log(`wrote ${opts.out}`);
}

async function tiles() {
  const bounds = openReader(opts.vector).metadata().bounds.split(',').map(Number);
  const minzoom = Number(opts.minzoom), maxzoom = Number(opts.maxzoom), size = Number(opts.metatile);
  const writer = openWriter(opts.out, {
    name: 'GPSmap.is', type: 'baselayer', version: '1', format: opts.format, attribution: 'GPSmap.is',
    description: 'Rendered from Garmin IMG', bounds: bounds.join(','), minzoom, maxzoom,
    center: `${(bounds[0] + bounds[2]) / 2},${(bounds[1] + bounds[3]) / 2},8`,
  });
  const jobs = [];
  for (let z = minzoom; z <= maxzoom; z++) {
    for (const meta of metatiles(bounds, z, size)) if (!writer.isDone(z, meta.mx, meta.my)) jobs.push(meta);
  }
  const total = jobs.length;
  console.log(`${total} metatiles to render (z${minzoom}-${maxzoom}, bounds ${bounds.join(',')})`);
  const cfg = JSON.stringify({ ...sources, out: opts.out, buffer: Number(opts.buffer), format: opts.format });
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  let done = 0, tilesDone = 0, lastLog = 0;
  const t0 = Date.now();
  const progress = () => {
    const now = Date.now();
    if (now - lastLog < 10000 && done !== total) return;
    lastLog = now;
    const rate = done / ((now - t0) / 1000);
    const eta = rate ? Math.round((total - done) / rate / 60) : '?';
    console.log(`${done}/${total} metatiles, ${tilesDone} tiles, ${rate.toFixed(1)} meta/s, ETA ${eta} min`);
  };
  await Promise.all(Array.from({ length: Math.min(Number(opts.workers), total) }, () => new Promise((resolve, reject) => {
    const worker = fork(workerPath, [cfg]);
    const next = () => {
      const job = jobs.shift();
      if (!job) { worker.kill(); resolve(); return; }
      worker.send(job);
    };
    worker.on('message', (msg) => {
      if (!msg.ok) { worker.kill(); reject(new Error(msg.error)); return; }
      done += 1;
      tilesDone += msg.n;
      progress();
      next();
    });
    worker.on('exit', (code) => { if (code && jobs.length) reject(new Error(`worker exited with ${code}`)); });
    next();
  })));
  writer.finish();
  writer.close();
  console.log(`done: ${tilesDone} tiles written to ${opts.out}`);
}

const command = positionals[0];
const run = command === 'sample' ? sample : command === 'tiles' ? tiles : null;
if (!run) {
  console.error('usage: render.mjs sample|tiles --style … --vector … --dem … --sprite DIR --fonts DIR --out …');
  process.exit(2);
}
run().catch((err) => { console.error(err); process.exit(1); });
