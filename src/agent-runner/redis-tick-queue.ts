import type { Redis } from 'ioredis';
import { TickPayloadSchema, type TickPayload } from './tick-queue-payload';
import type {
  QueueSnapshot,
  TickPayloadInput,
  TickQueue,
  TickQueueConsumer,
} from './tick-queue';

export interface RedisTickQueueDeps {
  producer: Redis;
  subscriber: Redis;
  keyPrefix?: string;
  now?: () => number;
}

const DEFAULT_KEY_PREFIX = 'agent-loop';

export class RedisTickQueue implements TickQueue {
  private readonly listKey: string;
  private readonly producer: Redis;
  private readonly subscriber: Redis;
  private readonly now: () => number;
  private stopped = false;

  constructor(deps: RedisTickQueueDeps) {
    const prefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.listKey = `${prefix}:queue`;
    this.producer = deps.producer;
    this.subscriber = deps.subscriber;
    this.now = deps.now ?? Date.now;
  }

  async enqueue(payload: TickPayloadInput): Promise<{ position: number }> {
    const validated = TickPayloadSchema.parse({ ...payload, enqueuedAt: this.now() });
    await this.producer.lpush(this.listKey, JSON.stringify(validated));
    const len = await this.producer.llen(this.listKey);
    return { position: len };
  }

  async hasScheduledFor(agentId: string): Promise<boolean> {
    const items = await this.producer.lrange(this.listKey, 0, -1);
    for (const raw of items) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.agentId === agentId && parsed.trigger === 'scheduled') return true;
      } catch {
        // ignore malformed entries
      }
    }
    return false;
  }

  async snapshot(): Promise<QueueSnapshot> {
    const items = await this.producer.lrange(this.listKey, 0, -1);
    const pending = items
      .map((raw) => {
        try {
          return JSON.parse(raw) as TickPayload;
        } catch {
          return null;
        }
      })
      .filter((p): p is TickPayload => p !== null)
      .reverse()
      .map((p) => ({ agentId: p.agentId, trigger: p.trigger, enqueuedAt: p.enqueuedAt }));
    return { current: null, pending };
  }

  consume(): TickQueueConsumer {
    return {
      next: () => this.pull(),
      stop: async () => {
        this.stopped = true;
        // disconnect (not quit) is required to unblock an in-flight BRPOP — quit waits for the
        // blocking command to finish, which never happens with BRPOP timeout=0.
        this.subscriber.disconnect();
      },
    };
  }

  private async pull(): Promise<TickPayload | null> {
    if (this.stopped) return null;
    try {
      const result = await this.subscriber.brpop(this.listKey, 0);
      if (!result) return null;
      const [, raw] = result;
      const parsed = TickPayloadSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.error('[redis-tq] dropped malformed payload:', raw, parsed.error.format());
        return this.pull();
      }
      return parsed.data;
    } catch (err) {
      if (this.stopped) return null;
      throw err;
    }
  }
}
