/**
 * A compact directed road graph shared by both routing engines (A: built from road lines,
 * B: decoded from Garmin's NOD routing data), plus fastest-route search and snapping.
 * Coordinates are Garmin map units (360° = 2^24).
 */

export const UNITS_PER_DEG = (1 << 24) / 360;
const EARTH_R = 6371008.8;

/** Edge flag: an F-road or 4×4 track (excluded when F-roads aren't allowed). */
export const EDGE_FROAD = 1;

export function metresBetween(x1: number, y1: number, x2: number, y2: number): number {
  const rad = Math.PI / 180 / UNITS_PER_DEG;
  const la1 = y1 * rad;
  const la2 = y2 * rad;
  const dLat = la2 - la1;
  const dLon = (x2 - x1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RoadGraph {
  nodeX: Int32Array;
  nodeY: Int32Array;
  /** CSR: edges of node n are edgeStart[n] .. edgeStart[n + 1] - 1. */
  edgeStart: Int32Array;
  edgeTo: Int32Array;
  /** Metres. */
  edgeLen: Float32Array;
  /** km/h used for travel time. */
  edgeSpeed: Float32Array;
  edgeFlags: Uint8Array;
  /** The edge's road: its map tile's index (0 when the edge has no road) and its NET offset
   *  (−1 when unknown). */
  edgeTile: Uint16Array;
  edgeNet: Int32Array;
  /** Optional shape per edge: points geomStart[e] .. geomStart[e + 1] - 1 of geomX/geomY, from
   *  the source node to the target (exclusive of both ends). Absent: straight between nodes. */
  geomStart?: Int32Array;
  geomX?: Int32Array;
  geomY?: Int32Array;
  maxSpeed: number;
}

/** Accumulates nodes (deduplicated by exact coordinate) and edges, then packs them. */
export class GraphBuilder {
  private readonly ids = new Map<number, number>();
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly from: number[] = [];
  private readonly to: number[] = [];
  private readonly len: number[] = [];
  private readonly speed: number[] = [];
  private readonly flags: number[] = [];
  private readonly tile: number[] = [];
  private readonly net: number[] = [];
  private readonly geom: Array<number[] | null> = [];
  private hasGeom = false;

  node(x: number, y: number): number {
    const key = (x + 0x800000) * 0x1000000 + (y + 0x800000);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.xs.length;
      this.ids.set(key, id);
      this.xs.push(x);
      this.ys.push(y);
    }
    return id;
  }

  /** Adds a directed edge; `shape` is the interior points as a flat [x, y, x, y, …] list. */
  edge(a: number, b: number, metres: number, kmh: number, flags: number, shape: number[] | null = null, road: { tile: number; net: number } | null = null): void {
    if (a === b) return;
    this.from.push(a);
    this.to.push(b);
    this.len.push(metres);
    this.speed.push(kmh);
    this.flags.push(flags);
    this.tile.push(road?.tile ?? 0);
    this.net.push(road?.net ?? -1);
    this.geom.push(shape);
    if (shape) this.hasGeom = true;
  }

  get nodeCount(): number {
    return this.xs.length;
  }

  build(): RoadGraph {
    const n = this.xs.length;
    const m = this.from.length;
    const edgeStart = new Int32Array(n + 1);
    for (const a of this.from) edgeStart[a + 1]++;
    for (let i = 0; i < n; i++) edgeStart[i + 1] += edgeStart[i];
    const fill = edgeStart.slice(0, n);
    const order = new Int32Array(m);
    for (let e = 0; e < m; e++) order[fill[this.from[e]]++] = e;
    const edgeTo = new Int32Array(m);
    const edgeLen = new Float32Array(m);
    const edgeSpeed = new Float32Array(m);
    const edgeFlags = new Uint8Array(m);
    const edgeTile = new Uint16Array(m);
    const edgeNet = new Int32Array(m);
    let maxSpeed = 1;
    let geomPoints = 0;
    if (this.hasGeom) for (const g of this.geom) geomPoints += g ? g.length / 2 : 0;
    const geomStart = this.hasGeom ? new Int32Array(m + 1) : undefined;
    const geomX = this.hasGeom ? new Int32Array(geomPoints) : undefined;
    const geomY = this.hasGeom ? new Int32Array(geomPoints) : undefined;
    let gp = 0;
    for (let i = 0; i < m; i++) {
      const e = order[i];
      edgeTo[i] = this.to[e];
      edgeLen[i] = this.len[e];
      edgeSpeed[i] = this.speed[e];
      edgeFlags[i] = this.flags[e];
      edgeTile[i] = this.tile[e];
      edgeNet[i] = this.net[e];
      if (this.speed[e] > maxSpeed) maxSpeed = this.speed[e];
      if (geomStart) {
        geomStart[i] = gp;
        const g = this.geom[e];
        if (g) for (let k = 0; k < g.length; k += 2) {
          geomX![gp] = g[k];
          geomY![gp++] = g[k + 1];
        }
      }
    }
    if (geomStart) geomStart[m] = gp;
    return { nodeX: Int32Array.from(this.xs), nodeY: Int32Array.from(this.ys), edgeStart, edgeTo, edgeLen, edgeSpeed, edgeFlags, edgeTile, edgeNet, geomStart, geomX, geomY, maxSpeed };
  }
}

export interface Route {
  /** Route shape as [lon, lat] degrees. */
  coords: Array<[number, number]>;
  metres: number;
  seconds: number;
  nodes: number[];
  edges: number[];
}

/** Binary min-heap of (key, value) pairs. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(k: number, v: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const k = keys.pop()!;
    const v = vals.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= keys.length) break;
        const r = l + 1;
        const c = r < keys.length && keys[r] < keys[l] ? r : l;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

/** Fastest route between two nodes (A*, time in seconds), or null when unreachable. */
export function fastestRoute(g: RoadGraph, from: number, to: number, allowFRoads: boolean): Route | null {
  const n = g.nodeX.length;
  const best = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const maxMs = g.maxSpeed / 3.6;
  const h = (v: number) => metresBetween(g.nodeX[v], g.nodeY[v], g.nodeX[to], g.nodeY[to]) / maxMs;
  const heap = new Heap();
  best[from] = 0;
  heap.push(h(from), from);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      if (!allowFRoads && g.edgeFlags[e] & EDGE_FROAD) continue;
      const v = g.edgeTo[e];
      if (done[v]) continue;
      const t = best[u] + g.edgeLen[e] / (g.edgeSpeed[e] / 3.6);
      if (t < best[v]) {
        best[v] = t;
        via[v] = e;
        heap.push(t + h(v), v);
      }
    }
  }
  if (!Number.isFinite(best[to])) return null;
  // Walk back through the edges, then emit the shape forwards.
  const edges: number[] = [];
  const edgeFrom: number[] = [];
  for (let v = to; v !== from; ) {
    const e = via[v];
    edges.push(e);
    let u = 0;
    // The source of edge e: binary search in edgeStart.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.edgeStart[mid + 1] <= e) lo = mid + 1;
      else hi = mid;
    }
    u = lo;
    edgeFrom.push(u);
    v = u;
  }
  edges.reverse();
  edgeFrom.reverse();
  const deg = (x: number) => x / UNITS_PER_DEG;
  const coords: Array<[number, number]> = [[deg(g.nodeX[from]), deg(g.nodeY[from])]];
  let metres = 0;
  const nodes = [from];
  for (const e of edges) {
    metres += g.edgeLen[e];
    if (g.geomStart) for (let k = g.geomStart[e]; k < g.geomStart[e + 1]; k++) coords.push([deg(g.geomX![k]), deg(g.geomY![k])]);
    const v = g.edgeTo[e];
    coords.push([deg(g.nodeX[v]), deg(g.nodeY[v])]);
    nodes.push(v);
  }
  return { coords, metres, seconds: best[to], nodes, edges };
}

/** Whether node `v` has an outgoing edge that isn't an F-road or track (so a route that may not
 *  use those can start or end there). */
export function hasNormalRoad(g: RoadGraph, v: number): boolean {
  for (let e = g.edgeStart[v]; e < g.edgeStart[v + 1]; e++) if (!(g.edgeFlags[e] & EDGE_FROAD)) return true;
  return false;
}

/** Grid index over the graph's nodes, for snapping a position to the nearest node. */
export class NodeIndex {
  private readonly cells = new Map<number, number[]>();
  private static readonly CELL = Math.round(0.05 * UNITS_PER_DEG);

  /** Indexes the nodes of the main road network (its largest connected part), so a position never
   *  snaps to an isolated stub, e.g. a parking loop that isn't joined to any road. */
  constructor(private readonly g: RoadGraph) {
    const C = NodeIndex.CELL;
    const main = largestComponent(g);
    for (let v = 0; v < g.nodeX.length; v++) {
      if (!main[v]) continue;
      const key = Math.floor(g.nodeX[v] / C) * 100000 + Math.floor(g.nodeY[v] / C);
      const list = this.cells.get(key);
      if (list) list.push(v);
      else this.cells.set(key, [v]);
    }
  }

  /** Nearest node within `maxMetres` that `accept` (when given) lets through, or null. */
  nearest(lon: number, lat: number, maxMetres: number, accept?: (node: number) => boolean): { node: number; metres: number } | null {
    const C = NodeIndex.CELL;
    const x = Math.round(lon * UNITS_PER_DEG);
    const y = Math.round(lat * UNITS_PER_DEG);
    const cx = Math.floor(x / C);
    const cy = Math.floor(y / C);
    let bestNode = -1;
    let bestM = maxMetres;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const v of this.cells.get((cx + dx) * 100000 + (cy + dy)) ?? []) {
        const m = metresBetween(x, y, this.g.nodeX[v], this.g.nodeY[v]);
        if (m <= bestM && (!accept || accept(v))) {
          bestM = m;
          bestNode = v;
        }
      }
    }
    return bestNode < 0 ? null : { node: bestNode, metres: bestM };
  }
}

/** Nodes of the largest connected part of the graph (edges taken as undirected). */
export function largestComponent(g: RoadGraph): Uint8Array {
  const n = g.nodeX.length;
  const comp = new Int32Array(n).fill(-1);
  // Undirected adjacency in CSR form: every edge in both directions.
  const deg = new Int32Array(n + 1);
  for (let u = 0; u < n; u++) for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) { deg[u + 1]++; deg[g.edgeTo[e] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, n);
  const adj = new Int32Array(deg[n]);
  for (let u = 0; u < n; u++) for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) { adj[fill[u]++] = g.edgeTo[e]; adj[fill[g.edgeTo[e]]++] = u; }
  let best = -1;
  let bestSize = 0;
  const stack: number[] = [];
  for (let s = 0, id = 0; s < n; s++, id++) {
    if (comp[s] >= 0) { id--; continue; }
    let size = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (let k = deg[u]; k < deg[u + 1]; k++) if (comp[adj[k]] < 0) { comp[adj[k]] = id; stack.push(adj[k]); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const out = new Uint8Array(n);
  for (let v = 0; v < n; v++) out[v] = comp[v] === best ? 1 : 0;
  return out;
}
