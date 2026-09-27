export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

// px, py are pixel coordinates in the 256-px tile world at zoom z
export function tilePixelToLonLat(px, py, z) {
  const n = 256 * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export function metatiles(bounds, z, size) {
  const [w, s, e, n] = bounds;
  const x0 = lonToTileX(w, z), x1 = lonToTileX(e, z);
  const y0 = latToTileY(n, z), y1 = latToTileY(s, z);
  const out = [];
  for (let my = Math.floor(y0 / size); my <= Math.floor(y1 / size); my++) {
    for (let mx = Math.floor(x0 / size); mx <= Math.floor(x1 / size); mx++) {
      const tiles = [];
      for (let y = Math.max(my * size, y0); y <= Math.min(my * size + size - 1, y1); y++) {
        for (let x = Math.max(mx * size, x0); x <= Math.min(mx * size + size - 1, x1); x++) tiles.push([x, y]);
      }
      out.push({ z, mx, my, size, tiles });
    }
  }
  return out;
}

// Raster zoom z is rendered at MapLibre zoom z - 1 (MapLibre's world is 512 px wide at zoom 0).
export function metatileView(meta, bufferPx) {
  const { z, mx, my, size } = meta;
  const center = tilePixelToLonLat((mx * size + size / 2) * 256, (my * size + size / 2) * 256, z);
  const px = size * 256 + 2 * bufferPx;
  return { zoom: z - 1, center, width: px, height: px };
}
