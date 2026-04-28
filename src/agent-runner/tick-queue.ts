export type TickTrigger = 'scheduled' | 'chat';

export interface QueueTask {
  agentId: string;
  trigger: TickTrigger;
  run: () => Promise<void>;
  enqueuedAt: number;
}

export interface QueueSnapshot {
  current: { agentId: string; trigger: TickTrigger; startedAt: number } | null;
  pending: { agentId: string; trigger: TickTrigger; enqueuedAt: number }[];
}

export interface TickQueue {
  enqueue(task: Omit<QueueTask, 'enqueuedAt'>): Promise<{ position: number }>;
  hasScheduledFor(agentId: string): boolean;
  snapshot(): QueueSnapshot;
  drain(): Promise<void>;
}

interface RunningTask {
  agentId: string;
  trigger: TickTrigger;
  startedAt: number;
}

export class InMemoryTickQueue implements TickQueue {
  private pending: QueueTask[] = [];
  private running: RunningTask | null = null;
  private now: () => number;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async enqueue(task: Omit<QueueTask, 'enqueuedAt'>): Promise<{ position: number }> {
    const full: QueueTask = { ...task, enqueuedAt: this.now() };
    this.pending.push(full);
    const position = this.pending.length + (this.running ? 1 : 0);
    if (!this.resolveIdle) {
      this.idlePromise = new Promise((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    void this.runDrain();
    return { position };
  }

  drain(): Promise<void> {
    return this.idlePromise;
  }

  hasScheduledFor(agentId: string): boolean {
    if (this.running && this.running.agentId === agentId && this.running.trigger === 'scheduled') return true;
    return this.pending.some((t) => t.agentId === agentId && t.trigger === 'scheduled');
  }

  snapshot(): QueueSnapshot {
    return {
      current: this.running ? { ...this.running } : null,
      pending: this.pending.map((t) => ({ agentId: t.agentId, trigger: t.trigger, enqueuedAt: t.enqueuedAt })),
    };
  }

  private async runDrain(): Promise<void> {
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) {
      if (this.resolveIdle) {
        const r = this.resolveIdle;
        this.resolveIdle = null;
        r();
      }
      return;
    }
    this.running = { agentId: next.agentId, trigger: next.trigger, startedAt: this.now() };
    try {
      await next.run();
    } catch (err) {
      console.error(`[tick-queue] task for agent=${next.agentId} trigger=${next.trigger} threw:`, err);
    } finally {
      this.running = null;
      void this.runDrain();
    }
  }
}
