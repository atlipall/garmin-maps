import sharp from 'sharp';
import { createMap } from './lib/renderer.mjs';
import { metatileView } from './lib/tiles.mjs';
import { openWriter } from './lib/mbtiles.mjs';

const cfg = JSON.parse(process.argv[2]);
const renderer = createMap(cfg);
const out = openWriter(cfg.out);

function encode(img, format) {
  return format === 'jpg' ? img.jpeg({ quality: 85, mozjpeg: true }) : img.png({ palette: true, effort: 4 });
}

process.on('message', async (meta) => {
  try {
    const view = metatileView(meta, cfg.buffer);
    const raw = await renderer.render(view);
    const image = sharp(raw, { raw: { width: view.width, height: view.height, channels: 4 } });
    const tiles = [];
    for (const [x, y] of meta.tiles) {
      const left = cfg.buffer + (x - meta.mx * meta.size) * 256;
      const top = cfg.buffer + (y - meta.my * meta.size) * 256;
      const data = await encode(image.clone().extract({ left, top, width: 256, height: 256 }), cfg.format).toBuffer();
      tiles.push({ x, y, data });
    }
    out.writeMetatile(meta, tiles);
    process.send({ ok: true, n: tiles.length });
  } catch (err) {
    process.send({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
});
