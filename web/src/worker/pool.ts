export interface OpenMeta {
  bounds: [number, number, number, number];
  typ: Uint8Array | null;
  tileIds: string[];
}

export interface TileResult {
  data: ArrayBuffer;
  ms: number;
  badSections: number;
  features: number;
}

type Pending = { worker: Worker; resolve: (v: any) => void; reject: (e: Error) => void };

/** Caps respawn attempts per slot so a worker that dies immediately on construction (e.g. a
 * broken build) can't respawn forever; past this it's left dead and routed around. */
const MAX_RESPAWNS_PER_SLOT = 3;

export class TilePool {
  /** `null` means that slot's worker died and ran out of respawn attempts. */
  private readonly workers: Array<Worker | null> = [];
  private readonly respawns: number[] = [];
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private opened = false;

  constructor(private readonly file: File, size: number) {
    for (let i = 0; i < size; i++) {
      this.respawns[i] = 0;
      this.workers[i] = this.spawn(i);
    }
  }

  private spawn(index: number): Worker {
    const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => this.onWorkerDown(index, w, new Error(e.message || 'worker error'));
    // A message that failed to deserialize doesn't necessarily mean the worker itself is dead,
    // so only its own pending calls are rejected (not a full respawn).
    w.onmessageerror = () => this.rejectPendingFor(w, new Error('worker message error'));
    return w;
  }

  /** A worker crashed or failed to load: fail its in-flight calls, then respawn it (re-sending
   * `open` before it's handed tile work) or, past the respawn cap, mark the slot dead so future
   * calls route around it instead of hanging forever. */
  private onWorkerDown(index: number, dead: Worker, err: Error): void {
    this.rejectPendingFor(dead, err);
    if (this.workers[index] !== dead) return; // already replaced/handled by an earlier event
    try {
      dead.terminate();
    } catch {
      // already gone
    }
    if (this.respawns[index] >= MAX_RESPAWNS_PER_SLOT) {
      this.workers[index] = null;
      return;
    }
    this.respawns[index] += 1;
    const w = this.spawn(index);
    this.workers[index] = w;
    if (this.opened) {
      // If re-opening also fails, the new worker's own onerror handler drives the next attempt.
      this.call(w, { type: 'open', file: this.file }).catch(() => {});
    }
  }

  private rejectPendingFor(w: Worker, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.worker === w) {
        this.pending.delete(id);
        p.reject(err);
      }
    }
  }

  private call(w: Worker, msg: Record<string, unknown>): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { worker: w, resolve, reject });
      w.postMessage({ ...msg, id });
    });
  }

  private onMessage(msg: { id: number; type: string; message?: string }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private live(): Worker[] {
    return this.workers.filter((w): w is Worker => w !== null);
  }

  async open(): Promise<OpenMeta> {
    this.opened = true;
    const live = this.live();
    if (!live.length) throw new Error('no workers available');
    const results = await Promise.all(live.map((w) => this.call(w, { type: 'open', file: this.file })));
    const { bounds, typ, tileIds } = results[0];
    return { bounds, typ, tileIds };
  }

  /** Neighbouring tiles go to the same worker so its subdivision cache is reused. */
  tile(z: number, x: number, y: number): Promise<TileResult> {
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    const w = live[((x >> 1) + (y >> 1) * 7) % live.length];
    return this.call(w, { type: 'tile', z, x, y });
  }
}
