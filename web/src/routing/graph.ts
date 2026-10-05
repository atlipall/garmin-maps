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
  /** The road's importance from the map, 0 (least: residential streets, minor roads) to 4 (main
   *  roads). */
  edgeRank: Uint8Array;
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
  private readonly rank: number[] = [];
  private readonly geom: Array<number[] | null> = [];
  private hasGeom = false;

  node(x: number, y: number): number {
    const key = xyKey(x, y);
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
  edge(a: number, b: number, metres: number, kmh: number, flags: number, shape: number[] | null = null, road: { tile: number; net: number } | null = null, rank = TOP_RANK): void {
    if (a === b) return;
    this.from.push(a);
    this.to.push(b);
    this.len.push(metres);
    this.speed.push(kmh);
    this.flags.push(flags);
    this.tile.push(road?.tile ?? 0);
    this.net.push(road?.net ?? -1);
    this.rank.push(rank);
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
    const edgeRank = new Uint8Array(m);
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
      edgeRank[i] = this.rank[e];
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
    return { nodeX: Int32Array.from(this.xs), nodeY: Int32Array.from(this.ys), edgeStart, edgeTo, edgeLen, edgeSpeed, edgeFlags, edgeTile, edgeNet, edgeRank, geomStart, geomX, geomY, maxSpeed };
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
  get topKey(): number {
    return this.keys[0];
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

/** A route end on the graph: a node plus the time (seconds) spent getting to it from the start
 *  point (for a source) or from it to the destination point (for a target). */
export interface Terminal {
  node: number;
  cost: number;
}

const terminals = (t: number | Terminal[]): Terminal[] => (typeof t === 'number' ? [{ node: t, cost: 0 }] : t);

/** With F-roads preferred, time on F-roads and tracks counts this much when choosing a route. */
export const PREFER_FROAD_WEIGHT = 0.6;

/** The most important road rank (main roads); an edge without one counts as this. */
export const TOP_RANK = 4;

/** How a route is chosen beyond driving time. `rankWeight[r]`: time on a normal road of rank r
 *  counts this much (≥ 1); `changeSeconds`: added each time the route turns onto another road.
 *  Both make it keep to main roads instead of shorter zig-zags through streets whose speed class
 *  equals the main road's (common in towns). F-roads and tracks are left to `fWeight`. */
export interface Preference {
  rankWeight: readonly number[];
  changeSeconds: number;
}

export const NO_PREFERENCE: Preference = { rankWeight: [1, 1, 1, 1, 1], changeSeconds: 0 };

/**
 * Fastest route (A*, time in seconds) from any of the sources to any of the targets, counting each
 * source's and target's cost, or null when none is reachable. `seconds` includes those costs,
 * `metres` only the edges'. A plain node stands for a single terminal with no cost. `fWeight` < 1
 * makes F-road and track time count for less when choosing (to prefer them); `seconds` is still
 * the real driving time.
 */
export function fastestRoute(g: RoadGraph, from: number | Terminal[], to: number | Terminal[], allowFRoads: boolean, fWeight = 1, pref: Preference = NO_PREFERENCE): Route | null {
  const sources = terminals(from);
  const targets = terminals(to);
  if (!sources.length || !targets.length) return null;
  const n = g.nodeX.length;
  const best = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const extra = new Map<number, number>();
  for (const t of targets) extra.set(t.node, Math.min(t.cost, extra.get(t.node) ?? Infinity));
  // An F-road counted at fWeight is as if driven 1/fWeight times faster.
  // 1 % above top speed: NOD lengths (2.4 m units) run a little short of the straight-line distance,
  // and the estimate must never exceed the real cost.
  const maxMs = (g.maxSpeed * 1.01) / 3.6 / Math.min(1, fWeight);
  // Admissible: the straight-line time at top speed to the nearest-in-total target.
  const h = (v: number) => {
    let m = Infinity;
    for (const t of targets) m = Math.min(m, metresBetween(g.nodeX[v], g.nodeY[v], g.nodeX[t.node], g.nodeY[t.node]) / maxMs + t.cost);
    return m;
  };
  const heap = new Heap();
  for (const s of sources) {
    if (s.cost < best[s.node]) {
      best[s.node] = s.cost;
      heap.push(s.cost + h(s.node), s.node);
    }
  }
  let bestTotal = Infinity;
  let end = -1;
  while (heap.size) {
    if (heap.topKey >= bestTotal) break; // nothing left can beat the best found
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const x = extra.get(u);
    if (x !== undefined && best[u] + x < bestTotal) {
      bestTotal = best[u] + x;
      end = u;
    }
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      if (!allowFRoads && g.edgeFlags[e] & EDGE_FROAD) continue;
      const v = g.edgeTo[e];
      if (done[v]) continue;
      const froad = g.edgeFlags[e] & EDGE_FROAD;
      const into = via[u];
      // Onto another road (not just across a map tile boundary, where a road's NET record changes).
      const change = into >= 0 && g.edgeTile[into] === g.edgeTile[e] && g.edgeNet[into] !== g.edgeNet[e] ? pref.changeSeconds : 0;
      const t = best[u] + (g.edgeLen[e] / (g.edgeSpeed[e] / 3.6)) * (froad ? fWeight : pref.rankWeight[g.edgeRank[e]]) + change;
      if (t < best[v]) {
        best[v] = t;
        via[v] = e;
        heap.push(t + h(v), v);
      }
    }
  }
  if (end < 0) return null;
  // Walk back through the edges to a source (a node reached by no edge), then emit the shape forwards.
  const edges: number[] = [];
  let start = end;
  while (via[start] >= 0) {
    const e = via[start];
    edges.push(e);
    start = edgeSource(g, e);
  }
  edges.reverse();
  const deg = (x: number) => x / UNITS_PER_DEG;
  const coords: Array<[number, number]> = [[deg(g.nodeX[start]), deg(g.nodeY[start])]];
  let metres = 0;
  // Real time: the terminals' costs plus the edges' unweighted times.
  let seconds = Math.min(...sources.filter((t) => t.node === start).map((t) => t.cost)) + extra.get(end)!;
  const nodes = [start];
  for (const e of edges) {
    metres += g.edgeLen[e];
    seconds += g.edgeLen[e] / (g.edgeSpeed[e] / 3.6);
    if (g.geomStart) for (let k = g.geomStart[e]; k < g.geomStart[e + 1]; k++) coords.push([deg(g.geomX![k]), deg(g.geomY![k])]);
    const v = g.edgeTo[e];
    coords.push([deg(g.nodeX[v]), deg(g.nodeY[v])]);
    nodes.push(v);
  }
  return { coords, metres, seconds, nodes, edges };
}

/** The node edge `e` leaves from (binary search in edgeStart). */
export function edgeSource(g: RoadGraph, e: number): number {
  let lo = 0;
  let hi = g.nodeX.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.edgeStart[mid + 1] <= e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether node `v` has an outgoing edge that isn't an F-road or track (so a route that may not
 *  use those can start there). */
export function hasNormalRoad(g: RoadGraph, v: number): boolean {
  for (let e = g.edgeStart[v]; e < g.edgeStart[v + 1]; e++) if (!(g.edgeFlags[e] & EDGE_FROAD)) return true;
  return false;
}

/** Whether node `v` has an outgoing edge a route may use (any, or only normal roads). */
export const canLeave = (g: RoadGraph, v: number, allowFRoads: boolean): boolean =>
  allowFRoads ? g.edgeStart[v + 1] > g.edgeStart[v] : hasNormalRoad(g, v);

const IN_ANY = 1;
const IN_NORMAL = 2;
const inbound = new WeakMap<RoadGraph, Uint8Array>();

/** Whether node `v` has an incoming edge a route may use (any, or only normal roads), so a route
 *  can end there. */
export function canArrive(g: RoadGraph, v: number, allowFRoads: boolean): boolean {
  let flags = inbound.get(g);
  if (!flags) {
    flags = new Uint8Array(g.nodeX.length);
    for (let e = 0; e < g.edgeTo.length; e++) flags[g.edgeTo[e]] |= IN_ANY | (g.edgeFlags[e] & EDGE_FROAD ? 0 : IN_NORMAL);
    inbound.set(g, flags);
  }
  return (flags[v] & (allowFRoads ? IN_ANY : IN_NORMAL)) !== 0;
}

/** Grid index over the graph's nodes, for snapping a position to the nearest node, plus a lookup
 *  of nodes by exact position. */
export class NodeIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly byXY = new Map<number, number>();
  private readonly main: Uint8Array;
  private static readonly CELL = Math.round(0.05 * UNITS_PER_DEG);

  /** Snapping uses the nodes of the main road network (its largest connected part) only, so a
   *  position never snaps to an isolated stub, e.g. a parking loop that isn't joined to any road. */
  constructor(private readonly g: RoadGraph) {
    const C = NodeIndex.CELL;
    this.main = largestComponent(g);
    for (let v = 0; v < g.nodeX.length; v++) {
      this.byXY.set(xyKey(g.nodeX[v], g.nodeY[v]), v);
      if (!this.main[v]) continue;
      const key = Math.floor(g.nodeX[v] / C) * 100000 + Math.floor(g.nodeY[v] / C);
      const list = this.cells.get(key);
      if (list) list.push(v);
      else this.cells.set(key, [v]);
    }
  }

  /** The node at exactly this position (map units), or -1. */
  nodeAt(x: number, y: number): number {
    return this.byXY.get(xyKey(x, y)) ?? -1;
  }

  /** Whether node `v` is part of the main road network. */
  inMain(v: number): boolean {
    return this.main[v] === 1;
  }

  /** Nearest main-network node within `maxMetres` that `accept` (when given) lets through, or null. */
  nearest(lon: number, lat: number, maxMetres: number, accept?: (node: number) => boolean): { node: number; metres: number } | null {
    const C = NodeIndex.CELL;
    const x = Math.round(lon * UNITS_PER_DEG);
    const y = Math.round(lat * UNITS_PER_DEG);
    const cx = Math.floor(x / C);
    const cy = Math.floor(y / C);
    // Enough cells each way to cover the radius (cells are narrower east-west away from the equator).
    const cellM = metresBetween(0, y, C, y);
    const rx = Math.ceil(maxMetres / Math.max(1, cellM));
    const ry = Math.ceil(maxMetres / metresBetween(0, 0, 0, C));
    let bestNode = -1;
    let bestM = maxMetres;
    for (let dx = -rx; dx <= rx; dx++) for (let dy = -ry; dy <= ry; dy++) {
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

const xyKey = (x: number, y: number) => (x + 0x800000) * 0x1000000 + (y + 0x800000);

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
