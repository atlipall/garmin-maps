import { ImgError, u16 } from '../img/bytes';
import { ImgContainer } from '../img/container';
import { LabelTable } from '../img/lbl';
import type { Chunk, RawObject, SubdivisionBytes } from '../img/rgn';
import type { ByteSource } from '../img/source';
import { hasData, parseTre, type Subdivision, type Tre } from '../img/tre';
import { CONTOUR_LINE_TYPES, contourLabel, EARLY_ROADS_ZOOM, zoomBands } from './zoom';

export interface MapTile {
  id: string;
  tre: Tre;
  labels: LabelTable;
  byLevel: Map<number, Subdivision[]>;
}

function named(name: string, err: unknown): Error {
  if (err instanceof ImgError) return new ImgError(`${name}: ${err.message}`);
  if (err instanceof RangeError) return new ImgError(`${name}: truncated or corrupt (${err.message})`);
  return err as Error;
}

export function objectName(tile: MapTile, obj: RawObject): string | null {
  const name = tile.labels.text(obj.label, obj.labelSrc);
  return name && obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type) ? contourLabel(name) : name;
}

export class GarminMap {
  private constructor(
    private readonly img: ImgContainer,
    readonly tiles: MapTile[],
    readonly bands: Map<number, [number, number]>,
    readonly bounds: [number, number, number, number],
    readonly typ: Uint8Array | null,
  ) {}

  static async open(src: ByteSource): Promise<GarminMap> {
    const img = await ImgContainer.open(src);
    const ids = img.tileIds();
    if (ids.length === 0) throw new ImgError('no map tiles (TRE subfiles) in IMG');
    const tiles: MapTile[] = [];
    for (const id of ids) {
      for (const ext of ['TRE', 'RGN', 'LBL']) if (!img.has(`${id}.${ext}`)) throw new ImgError(`${id}: missing ${ext} subfile`);
      let tre: Tre;
      try {
        const rgnName = `${id}.RGN`;
        const hlen = u16(await img.read(rgnName, 0, 2), 0);
        tre = parseTre(await img.read(`${id}.TRE`), await img.read(rgnName, 0, hlen));
      } catch (err) {
        throw named(`${id}.TRE`, err);
      }
      let labels: LabelTable;
      try {
        labels = new LabelTable(await img.read(`${id}.LBL`), img.has(`${id}.NET`) ? await img.read(`${id}.NET`) : null);
      } catch (err) {
        throw named(`${id}.LBL`, err);
      }
      const byLevel = new Map<number, Subdivision[]>();
      for (const sd of tre.subdivisions) {
        if (!hasData(sd)) continue;
        const list = byLevel.get(sd.level.bits) ?? [];
        list.push(sd);
        byLevel.set(sd.level.bits, list);
      }
      tiles.push({ id, tre, labels, byLevel });
    }
    const bands = zoomBands(tiles.flatMap((t) => [...t.byLevel.keys()]));
    const bounds: [number, number, number, number] = [
      Math.min(...tiles.map((t) => t.tre.west)), Math.min(...tiles.map((t) => t.tre.south)),
      Math.max(...tiles.map((t) => t.tre.east)), Math.max(...tiles.map((t) => t.tre.north)),
    ];
    const typName = img.firstOfType('TYP');
    return new GarminMap(img, tiles, bands, bounds, typName ? await img.read(typName) : null);
  }

  levelForZoom(z: number): number | undefined {
    for (const [bits, [a, b]] of this.bands) if (z >= a && z <= b) return bits;
    return undefined;
  }

  /** The level whose roads a tile at zoom z shows, when it differs from `levelForZoom(z)`:
   *  the next finer level, for the coarsest level's zooms from EARLY_ROADS_ZOOM on. */
  roadLevelForZoom(z: number): number | undefined {
    const levels = [...this.bands.keys()].sort((a, b) => a - b);
    return z >= EARLY_ROADS_ZOOM && levels.length > 1 && this.levelForZoom(z) === levels[0] ? levels[1] : undefined;
  }

  async readSubdivision(tile: MapTile, sd: Subdivision): Promise<SubdivisionBytes> {
    const rgn = `${tile.id}.RGN`;
    const chunk = async (a: number, e: number): Promise<Chunk> => ({ bytes: e > a ? await this.img.read(rgn, a, e - a) : new Uint8Array(0), base: a });
    const [main, pg, ln, pt] = await Promise.all([chunk(sd.rgnStart, sd.rgnEnd), ...sd.ext.map(([a, e]) => chunk(a, e))]);
    return { main, ext: [pg, ln, pt] };
  }

  /** A whole subfile (e.g. `14057406.NOD`), or null when the map doesn't have it. */
  async readSubfile(name: string): Promise<Uint8Array | null> {
    return this.img.has(name) ? this.img.read(name) : null;
  }
}
