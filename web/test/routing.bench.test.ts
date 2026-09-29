/** Routing engine comparison on the real map. Run with: BENCH=1 vitest run test/routing.bench.test.ts */
import { test } from 'vitest';
import { GarminMap } from '../src/map/garminMap';
import { ImgContainer } from '../src/img/container';
import { graphFromLines, roadLines } from '../src/routing/engineA';
import { fRoadNets, graphFromNod } from '../src/routing/engineB';
import { fastestRoute, NodeIndex, type RoadGraph } from '../src/routing/graph';
import { nodeSource } from './helpers/nodeSource';
import { REPO } from './helpers/paths';

const MAPS = REPO + 'GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/';
export const ROUTES: Array<[string, [number, number], [number, number]]> = [
  ['Reykjavík → Akureyri', [-21.94, 64.146], [-18.09, 65.68]],
  ['Reykjavík → Selfoss', [-21.94, 64.146], [-21.0, 63.936]],
  ['Reykjavík → Höfn', [-21.94, 64.146], [-15.21, 64.25]],
  ['Reykjavík → Ísafjörður', [-21.94, 64.146], [-23.124, 66.075]],
  ['Akureyri → Egilsstaðir', [-18.09, 65.68], [-14.4, 65.26]],
  ['Selfoss → Landmannalaugar', [-21.0, 63.936], [-19.06, 63.991]],
  ['Reykjavík → Hveravellir (Kjölur)', [-21.94, 64.146], [-19.56, 64.866]],
  ['Egilsstaðir → Askja (Drekagil)', [-14.4, 65.26], [-16.60, 65.04]],
  ['Vík → Þórsmörk', [-19.0, 63.42], [-19.5, 63.68]],
  ['Húsavík → Dettifoss', [-17.34, 66.045], [-16.39, 65.81]],
  ['Grindavík → Keflavík airport', [-22.43, 63.84], [-22.62, 63.99]],
  ['Hallgrímskirkja → Harpa (one-ways)', [-21.9266, 64.1417], [-21.932, 64.150]],
];

function components(g: RoadGraph): number[] {
  const n = g.nodeX.length;
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  // Treat edges as undirected for connectivity.
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) { adj[u].push(g.edgeTo[e]); adj[g.edgeTo[e]].push(u); }
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) { const u = stack.pop()!; size++; for (const v of adj[u]) if (comp[v] < 0) { comp[v] = id; stack.push(v); } }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

const results = new Map<string, Map<string, Array<[number, number]>>>();

/** Share of route a's length that lies within 60 m of route b. */
function overlap(a: Array<[number, number]>, b: Array<[number, number]>): number {
  const cell = 0.002;
  const grid = new Set<string>();
  const addPt = (lon: number, lat: number) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) grid.add(`${Math.floor(lon / (cell * 2)) + dx},${Math.floor(lat / cell) + dy}`); };
  for (let i = 1; i < b.length; i++) {
    const steps = Math.ceil(Math.hypot((b[i][0] - b[i - 1][0]) * 0.44, b[i][1] - b[i - 1][1]) / 0.0005) || 1;
    for (let k = 0; k <= steps; k++) addPt(b[i - 1][0] + ((b[i][0] - b[i - 1][0]) * k) / steps, b[i - 1][1] + ((b[i][1] - b[i - 1][1]) * k) / steps);
  }
  let inside = 0, total = 0;
  for (let i = 1; i < a.length; i++) {
    const d = Math.hypot((a[i][0] - a[i - 1][0]) * 0.44, a[i][1] - a[i - 1][1]);
    total += d;
    if (grid.has(`${Math.floor(a[i][0] / (cell * 2))},${Math.floor(a[i][1] / cell)}`)) inside += d;
  }
  return total ? inside / total : 1;
}

export function report(name: string, g: RoadGraph, buildMs: number, heapMb: number, key = name): void {
  const routes = new Map<string, Array<[number, number]>>();
  results.set(key, routes);
  const sizes = components(g);
  console.log(`\n=== ${name}: build ${buildMs.toFixed(0)} ms, ~${heapMb.toFixed(0)} MB, ${g.nodeX.length} nodes, ${g.edgeTo.length} edges; largest component ${(100 * sizes[0] / g.nodeX.length).toFixed(1)}% (${sizes.length} components)`);
  const idx = new NodeIndex(g);
  for (const [label, a, b] of ROUTES) {
    const na = idx.nearest(a[0], a[1], 2000);
    const nb = idx.nearest(b[0], b[1], 2000);
    if (!na || !nb) { console.log(`${label.padEnd(36)} no road within 2 km of ${!na ? 'start' : 'end'}`); continue; }
    const cells: string[] = [];
    for (const allow of [true, false]) {
      const t0 = performance.now();
      const r = fastestRoute(g, na.node, nb.node, allow);
      const ms = performance.now() - t0;
      if (allow && r) routes.set(label, r.coords);
      cells.push(r ? `${(r.metres / 1000).toFixed(1).padStart(6)} km ${(r.seconds / 3600).toFixed(2).padStart(5)} h ${ms.toFixed(0).padStart(4)} ms` : `${'no route'.padStart(20)} ${ms.toFixed(0).padStart(4)} ms`);
    }
    console.log(`${label.padEnd(36)} F on: ${cells[0]}   F off: ${cells[1]}`);
  }
}

test.skipIf(!process.env.BENCH)('engine A', async () => {
  const map = await GarminMap.open(await nodeSource(MAPS + 'Iceland GPSmap.is 2024.21 F-Road Detailed.img'));
  globalThis.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const lines = await roadLines(map);
  const tLines = performance.now() - t0;
  const g = graphFromLines(lines);
  const ms = performance.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  console.log(`A: decoding road lines ${tLines.toFixed(0)} ms (${lines.length} lines), graph ${(ms - tLines).toFixed(0)} ms`);
  report('Engine A (road lines)', g, ms, heapMb, 'A');
}, 600_000);

test.skipIf(!process.env.BENCH)('engine B', async () => {
  const path = MAPS + 'Iceland GPSmap.is 2024.21 F-Road Detailed.img';
  const img = await ImgContainer.open(await nodeSource(path));
  const map = await GarminMap.open(await nodeSource(path));
  globalThis.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  let t0 = performance.now();
  const bare = await graphFromNod(img);
  const bareMs = performance.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  t0 = performance.now();
  const f = fRoadNets(await roadLines(map));
  const fMs = performance.now() - t0;
  const g = await graphFromNod(img, f);
  console.log(`B: NOD network ${bareMs.toFixed(0)} ms; F-road lookup from road lines ${fMs.toFixed(0)} ms`);
  report('Engine B (Garmin NOD), with F-road lookup', g, bareMs + fMs, heapMb, 'B');
  void bare;
}, 600_000);

test.skipIf(!process.env.BENCH)('overlap of A and B routes', () => {
  const A = results.get('A');
  const B = results.get('B');
  if (!A || !B) return;
  console.log('\n=== Route overlap (share of A within ~60 m of B, F-roads allowed)');
  for (const [label] of ROUTES) {
    const a = A.get(label);
    const b = B.get(label);
    console.log(`${label.padEnd(36)} ${a && b ? (100 * overlap(a, b)).toFixed(0) + '%' : 'n/a'}`);
  }
});

