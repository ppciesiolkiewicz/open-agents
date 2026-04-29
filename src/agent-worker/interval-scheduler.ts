export interface IntervalSchedulerOptions {
  tickIntervalMs: number;
  onTick: () => Promise<void>;
}

export class IntervalScheduler {
  private readonly tickIntervalMs: number;
  private readonly onTick: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: IntervalSchedulerOptions) {
    this.tickIntervalMs = opts.tickIntervalMs;
    this.onTick = opts.onTick;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.onTick().catch((err) => {
        console.error('[scheduler] tick error:', err);
      });
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
