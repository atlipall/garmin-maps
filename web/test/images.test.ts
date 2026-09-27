import { describe, expect, test } from 'vitest';
import type { RgbaImage } from '../src/img/typ';
import { preloadImages } from '../src/ui/images';

const img = (n: number): RgbaImage => ({ width: 1, height: 1, data: new Uint8Array([n, n, n, 255]) });

class FakeMap {
  readonly added: string[] = [];
  private readonly present = new Set<string>();

  constructor(preexisting: string[] = []) {
    for (const id of preexisting) this.present.add(id);
  }

  hasImage(id: string): boolean {
    return this.present.has(id);
  }

  addImage(id: string, _image: RgbaImage): void {
    this.added.push(id);
    this.present.add(id);
  }
}

describe('preloadImages', () => {
  test('adds every image the map does not already have', () => {
    const map = new FakeMap();
    const images = new Map([['pt-1', img(1)], ['pg-2', img(2)], ['pt-3', img(3)]]);
    preloadImages(map, images);
    expect(map.added.sort()).toEqual(['pg-2', 'pt-1', 'pt-3']);
    for (const id of images.keys()) expect(map.hasImage(id)).toBe(true);
  });

  test('skips images already registered on the map', () => {
    const map = new FakeMap(['pt-1']);
    const images = new Map([['pt-1', img(1)], ['pt-2', img(2)]]);
    preloadImages(map, images);
    expect(map.added).toEqual(['pt-2']);
  });

  test('empty images map adds nothing', () => {
    const map = new FakeMap();
    preloadImages(map, new Map());
    expect(map.added).toEqual([]);
  });
});
