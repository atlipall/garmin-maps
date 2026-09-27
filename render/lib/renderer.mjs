import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import mbgl from '@maplibre/maplibre-gl-native';
import { openReader } from './mbtiles.mjs';

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function createMap({ style, vector, dem, sprite, fonts }) {
  const readers = { vector: openReader(vector), dem: openReader(dem) };
  const map = new mbgl.Map({
    ratio: 1,
    request(req, callback) {
      try {
        const url = req.url;
        let data = null;
        if (url.startsWith('mbtiles://')) {
          const [source, z, x, y] = url.slice('mbtiles://'.length).split('/');
          data = readers[source].get(Number(z), Number(x), Number(y));
          if (data && data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
        } else if (url.startsWith('fonts://')) {
          const rest = decodeURIComponent(url.slice('fonts://'.length));
          const slash = rest.lastIndexOf('/');
          const stack = rest.slice(0, slash).split(',')[0].trim();
          data = readIfExists(path.join(fonts, stack, rest.slice(slash + 1)));
        } else if (url.startsWith('sprite://')) {
          data = readIfExists(path.join(sprite, path.basename(url.slice('sprite://'.length))));
        }
        if (data) callback(null, { data });
        else callback();
      } catch (err) {
        callback(err);
      }
    },
  });
  map.load(typeof style === 'string' ? JSON.parse(fs.readFileSync(style, 'utf8')) : style);
  return {
    render(view) {
      return new Promise((resolve, reject) => {
        map.render(view, (err, buffer) => (err ? reject(err) : resolve(buffer)));
      });
    },
    release() {
      map.release();
      readers.vector.close();
      readers.dem.close();
    },
  };
}
