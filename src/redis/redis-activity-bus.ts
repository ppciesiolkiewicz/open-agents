import type { Redis } from 'ioredis';
import type { ActivityBus, AgentActivityEvent } from '../database/activity-bus';

export interface RedisActivityBusDeps {
  publisher: Redis;
  subscriber: Redis;
  channelPrefix?: string;
}

const DEFAULT_CHANNEL_PREFIX = 'agent-loop:activity';

export class RedisActivityBus implements ActivityBus {
  private readonly channelPrefix: string;
  private readonly listenersByAgent = new Map<string, Set<(e: AgentActivityEvent) => void>>();
  private readonly subscribedChannels = new Set<string>();
  private wired = false;

  constructor(private readonly deps: RedisActivityBusDeps) {
    this.channelPrefix = deps.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
  }

  async publish(event: AgentActivityEvent): Promise<void> {
    const agentId = event.kind === 'append' ? event.entry.agentId : event.agentId;
    await this.deps.publisher.publish(this.channelFor(agentId), JSON.stringify(event));
  }

  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    this.ensureWired();
    let bucket = this.listenersByAgent.get(agentId);
    if (!bucket) {
      bucket = new Set();
      this.listenersByAgent.set(agentId, bucket);
    }
    bucket.add(listener);

    const channel = this.channelFor(agentId);
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      void this.deps.subscriber.subscribe(channel);
    }

    return () => {
      bucket?.delete(listener);
      if (bucket && bucket.size === 0) {
        this.listenersByAgent.delete(agentId);
        this.subscribedChannels.delete(channel);
        void this.deps.subscriber.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.listenersByAgent.clear();
    this.subscribedChannels.clear();
    try {
      await this.deps.subscriber.quit();
    } catch {
      // already closed
    }
    try {
      await this.deps.publisher.quit();
    } catch {
      // already closed
    }
  }

  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.deps.subscriber.on('message', (channel: string, raw: string) => {
      const agentId = this.agentIdFromChannel(channel);
      if (!agentId) return;
      let event: AgentActivityEvent;
      try {
        event = JSON.parse(raw) as AgentActivityEvent;
      } catch {
        return;
      }
      const bucket = this.listenersByAgent.get(agentId);
      if (!bucket) return;
      for (const listener of bucket) {
        try {
          listener(event);
        } catch (err) {
          console.error('[redis-bus] listener threw:', err);
        }
      }
    });
  }

  private channelFor(agentId: string): string {
    return `${this.channelPrefix}:${agentId}`;
  }

  private agentIdFromChannel(channel: string): string | null {
    const prefix = `${this.channelPrefix}:`;
    if (!channel.startsWith(prefix)) return null;
    return channel.slice(prefix.length);
  }
}
