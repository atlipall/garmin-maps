import test from 'node:test';
import assert from 'node:assert/strict';
import { lonToTileX, latToTileY, tilePixelToLonLat, metatiles, metatileView } from '../lib/tiles.mjs';

test('tile indices at low zoom', () => {
  assert.equal(lonToTileX(-180, 0), 0);
  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.equal(latToTileY(60, 1), 0);
});

test('tile corner round-trips', () => {
  const z = 15, x = 14387, y = 7890;
  const [lon, lat] = tilePixelToLonLat(x * 256 + 1, y * 256 + 1, z);
  assert.equal(lonToTileX(lon, z), x);
  assert.equal(latToTileY(lat, z), y);
});

test('metatiles cover the bounds exactly once', () => {
  const metas = metatiles([-22, 64, -21.5, 64.2], 12, 8);
  const all = metas.flatMap((m) => m.tiles.map(([x, y]) => `${x}/${y}`));
  assert.equal(new Set(all).size, all.length);
  const x0 = lonToTileX(-22, 12), x1 = lonToTileX(-21.5, 12);
  const y0 = latToTileY(64.2, 12), y1 = latToTileY(64, 12);
  assert.equal(all.length, (x1 - x0 + 1) * (y1 - y0 + 1));
});

test('metatile view renders one zoom lower with a buffer', () => {
  const view = metatileView({ z: 10, mx: 0, my: 0, size: 8, tiles: [] }, 256);
  assert.equal(view.zoom, 9);
  assert.equal(view.width, 8 * 256 + 512);
  const [lon] = tilePixelToLonLat(4 * 256, 4 * 256, 10);
  assert.equal(view.center[0], lon);
});
