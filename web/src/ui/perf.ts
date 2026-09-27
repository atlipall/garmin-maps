export class PerfStats {
  private readonly ms: number[] = [];
  private bad = 0;
  private features = 0;

  constructor(private readonly el: HTMLElement) {}

  record(ms: number, badSections: number, features: number): void {
    this.ms.push(ms);
    this.bad += badSections;
    this.features += features;
    this.el.textContent = this.summary();
  }

  summary(): string {
    if (!this.ms.length) return 'no tiles yet';
    const s = [...this.ms].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0);
    return `tiles ${s.length}  p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${s[s.length - 1].toFixed(0)} ms\n` +
      `features ${this.features}  bad sections ${this.bad}`;
  }
}
