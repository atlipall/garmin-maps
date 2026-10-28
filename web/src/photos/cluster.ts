/**
 * Photos close together on screen as one thumbnail: greedy grouping in screen pixels, oldest photo
 * first, so a group keeps its place and its picture as the map moves.
 */

export interface ScreenPoint<T> {
  item: T;
  x: number;
  y: number;
}

export interface Group<T> {
  /** Where the thumbnail goes: the first photo's spot. */
  x: number;
  y: number;
  items: T[];
}

/** Groups points within `radius` px of a group's first point; `points` in the order to take them. */
export function cluster<T>(points: ScreenPoint<T>[], radius: number): Group<T>[] {
  const groups: Group<T>[] = [];
  const r2 = radius * radius;
  // A grid of `radius`-sized cells: a point only needs the groups in its cell and the 8 around it.
  const cells = new Map<string, Group<T>[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const p of points) {
    const cx = Math.floor(p.x / radius);
    const cy = Math.floor(p.y / radius);
    let best: Group<T> | null = null;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const g of cells.get(key(cx + dx, cy + dy)) ?? []) {
          const d = (g.x - p.x) ** 2 + (g.y - p.y) ** 2;
          if (d <= r2 && d < bestD) {
            best = g;
            bestD = d;
          }
        }
      }
    }
    if (best) {
      best.items.push(p.item);
      continue;
    }
    const g: Group<T> = { x: p.x, y: p.y, items: [p.item] };
    groups.push(g);
    const k = key(cx, cy);
    cells.set(k, [...(cells.get(k) ?? []), g]);
  }
  return groups;
}
