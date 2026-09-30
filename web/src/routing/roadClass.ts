/** How a road may be used and how fast: 0 normal road, 1 F-road, 2 track, 3 rough 4×4 track. */
export type RoadClass = 0 | 1 | 2 | 3;

/** Per map tile: [NET offset, class] of the roads whose class isn't 0. NET offsets are per tile. */
export type RoadClasses = Record<string, Array<[number, RoadClass]>>;

/** Speed caps (km/h) per class, applied on top of Garmin's speed class. */
export const CLASS_CAP_KMH: readonly number[] = [Infinity, 35, 20, 15];

const F_NAME = /^F\s?\d+/i;

export function roadClass(type: number, name: string | null): RoadClass {
  if (type === 0x13) return 3;
  if (type === 0x11) return 2;
  if (type === 0x12 || (name !== null && F_NAME.test(name))) return 1;
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
