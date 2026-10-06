/** How a road may be used and how fast: 0 normal road, 1 F-road, 2 track, 3 rough 4×4 track. */
export type RoadClass = 0 | 1 | 2 | 3;

/** Per map tile: [NET offset, class] of the roads whose class isn't 0. NET offsets are per tile. */
export type RoadClasses = Record<string, Array<[number, RoadClass]>>;

/** Speed caps (km/h) per class, applied on top of Garmin's speed class. */
export const CLASS_CAP_KMH: readonly number[] = [Infinity, 40, 25, 20];

const F_NAME = /^F\s?\d+/i;

/** A name that is an F-road number ("F208", "F 26"). */
export const isFRoadName = (name: string | null) => name !== null && F_NAME.test(name);

/** A road's class from its type and its names: all of a road's labels, since some maps give the
 *  road number as a second label ("Fjallabaksleið nyrðri" and "F208" on Freizeitkarte). */
export function roadClass(type: number, names: string | null | readonly string[]): RoadClass {
  if (type === 0x13) return 3;
  if (type === 0x11) return 2;
  const list = names === null ? [] : typeof names === 'string' ? [names] : names;
  if (type === 0x12 || list.some((n) => F_NAME.test(n))) return 1;
  return 0;
}

/** Builds a RoadClasses table with one entry per NET offset per tile: a road drawn as several lines
 *  (or split across subdivisions) shares one NET offset. Class-0 roads are left out. */
export class RoadClassCollector {
  readonly roads: RoadClasses = {};
  private readonly seen = new Map<string, Set<number>>();

  add(tileId: string, net: number, cls: RoadClass): void {
    if (!cls) return;
    let nets = this.seen.get(tileId);
    if (!nets) this.seen.set(tileId, (nets = new Set()));
    if (nets.has(net)) return;
    nets.add(net);
    (this.roads[tileId] ??= []).push([net, cls]);
  }
}
