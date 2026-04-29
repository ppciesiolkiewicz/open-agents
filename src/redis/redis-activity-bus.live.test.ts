import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RedisClient } from './redis-client';
import { RedisActivityBus } from './redis-activity-bus';
import type { AgentActivityEvent } from '../database/activity-bus';

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required to run live Redis tests');
  return url;
}

describe('RedisActivityBus (live)', () => {
  const REDIS_URL = requireRedisUrl();
  const channelPrefix = `test:bus:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let publisher: RedisActivityBus;
  let subscriber: RedisActivityBus;

  beforeEach(() => {
    publisher = new RedisActivityBus({ publisher: RedisClient.build(REDIS_URL), subscriber: RedisClient.build(REDIS_URL), channelPrefix });
    subscriber = new RedisActivityBus({ publisher: RedisClient.build(REDIS_URL), subscriber: RedisClient.build(REDIS_URL), channelPrefix });
  });

  afterEach(async () => {
    await publisher.close();
    await subscriber.close();
  });

  it('delivers an ephemeral event from publisher to subscriber', async () => {
    const received: AgentActivityEvent[] = [];
    const unsubscribe = subscriber.subscribe('a1', (e) => received.push(e));

    await new Promise((r) => setTimeout(r, 100));

    await publisher.publish({ kind: 'ephemeral', agentId: 'a1', payload: { type: 'token', text: 'hello' } });

    await new Promise((r) => setTimeout(r, 100));
    console.log('[redis-bus] received:', received);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'ephemeral', payload: { type: 'token', text: 'hello' } });

    unsubscribe();
  });

  it('does not deliver to subscribers of a different agent', async () => {
    const received: AgentActivityEvent[] = [];
    subscriber.subscribe('other-agent', (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 100));

    await publisher.publish({ kind: 'ephemeral', agentId: 'a1', payload: { type: 'token' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });
});
