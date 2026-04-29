import { TickPayloadSchema, type TickPayload } from './tick-queue-payload';

export type TickTrigger = TickPayload['trigger'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TickPayloadInput = DistributiveOmit<TickPayload, 'enqueuedAt'>;

export interface QueueSnapshot {
  current: { agentId: string; trigger: TickTrigger; startedAt: number } | null;
  pending: { agentId: string; trigger: TickTrigger; enqueuedAt: number }[];
}

export interface TickQueue {
  enqueue(payload: TickPayloadInput): Promise<{ position: number }>;
  hasScheduledFor(agentId: string): Promise<boolean>;
  snapshot(): Promise<QueueSnapshot>;
  consume(): TickQueueConsumer;
  markStarted?(payload: TickPayload): void;
  markFinished?(payload: TickPayload): void;
}

export interface TickQueueConsumer {
  next(): Promise<TickPayload | null>;
  stop(): Promise<void>;
}

export interface InMemoryTickQueueDeps {
  now?: () => number;
  notify?: (agentId: string, payload: Record<string, unknown>) => void;
}

export class InMemoryTickQueue implements TickQueue {
  private pending: TickPayload[] = [];
  private current: { agentId: string; trigger: TickTrigger; startedAt: number } | null = null;
  private waiters: Array<(p: TickPayload | null) => void> = [];
  private stopped = false;
  private now: () => number;
  private notify: (agentId: string, payload: Record<string, unknown>) => void;

  constructor(deps: InMemoryTickQueueDeps | (() => number) = {}) {
    if (typeof deps === 'function') {
      this.now = deps;
      this.notify = () => {};
    } else {
      this.now = deps.now ?? Date.now;
      this.notify = deps.notify ?? (() => {});
    }
  }

  async enqueue(payload: TickPayloadInput): Promise<{ position: number }> {
    const full = TickPayloadSchema.parse({ ...payload, enqueuedAt: this.now() });
    this.pending.push(full);
    const position = this.pending.length + (this.current ? 1 : 0);
    this.notify(full.agentId, { type: 'task_queued', position, trigger: full.trigger });
    this.flushWaiter();
    return { position };
  }

  async hasScheduledFor(agentId: string): Promise<boolean> {
    if (this.current && this.current.agentId === agentId && this.current.trigger === 'scheduled') return true;
    return this.pending.some((p) => p.agentId === agentId && p.trigger === 'scheduled');
  }

  async snapshot(): Promise<QueueSnapshot> {
    return {
      current: this.current ? { ...this.current } : null,
      pending: this.pending.map((p) => ({ agentId: p.agentId, trigger: p.trigger, enqueuedAt: p.enqueuedAt })),
    };
  }

  consume(): TickQueueConsumer {
    return {
      next: () => this.pull(),
      stop: async () => {
        this.stopped = true;
        for (const w of this.waiters) w(null);
        this.waiters = [];
      },
    };
  }

  markStarted(payload: TickPayload): void {
    this.current = { agentId: payload.agentId, trigger: payload.trigger, startedAt: this.now() };
    this.notify(payload.agentId, { type: 'task_started', trigger: payload.trigger });
  }

  markFinished(payload: TickPayload): void {
    this.notify(payload.agentId, { type: 'task_finished', trigger: payload.trigger });
    this.current = null;
  }

  private pull(): Promise<TickPayload | null> {
    if (this.stopped) return Promise.resolve(null);
    const next = this.pending.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private flushWaiter(): void {
    const w = this.waiters.shift();
    if (!w) return;
    const next = this.pending.shift();
    w(next ?? null);
  }
}
