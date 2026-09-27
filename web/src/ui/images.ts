import type { RgbaImage } from '../img/typ';

/** The subset of maplibre-gl's `Map` API that `preloadImages` needs, kept minimal and
 * structural so it can be unit tested with a plain fake instead of a real WebGL map. */
export interface ImageTarget {
  hasImage(id: string): boolean;
  addImage(id: string, image: RgbaImage): void;
}

/**
 * Registers every style image on the map up front, before any tile has been requested.
 *
 * Without this, the only registration path is the `styleimagemissing` event: MapLibre fires it,
 * and *in the same synchronous pass* also logs `Image "X" could not be loaded` and finishes
 * building that tile's symbol bucket without the icon, because it only checks whether the image
 * is already present, not whether this event's handler is about to add it (see
 * `ImageManager._getImagesForIds` in maplibre-gl). MapLibre does reload affected tiles once the
 * image lands, but that costs an extra round trip and the noisy warning is real, first-request
 * behaviour, not a one-off fluke. Calling this once, synchronously, right after the map is
 * created (tile fetches are always async) means every tile's first symbol-bucket build already
 * finds every icon and pattern in place, so the event/warning path is never exercised for images
 * we already know about at open time.
 */
export function preloadImages(map: ImageTarget, images: Map<string, RgbaImage>): void {
  for (const [id, image] of images) {
    if (!map.hasImage(id)) map.addImage(id, image);
  }
}
