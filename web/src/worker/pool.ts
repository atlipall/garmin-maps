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

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class TilePool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private seq = 0;

  constructor(private readonly file: File, size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.onMessage(e.data);
      w.onerror = (e) => this.failAll(new Error(e.message || 'worker error'));
      this.workers.push(w);
    }
  }

  private call(w: Worker, msg: Record<string, unknown>): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async open(): Promise<OpenMeta> {
    const results = await Promise.all(this.workers.map((w) => this.call(w, { type: 'open', file: this.file })));
    const { bounds, typ, tileIds } = results[0];
    return { bounds, typ, tileIds };
  }

  /** Neighbouring tiles go to the same worker so its subdivision cache is reused. */
  tile(z: number, x: number, y: number): Promise<TileResult> {
    const w = this.workers[((x >> 1) + (y >> 1) * 7) % this.workers.length];
    return this.call(w, { type: 'tile', z, x, y });
  }
}
