import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRedisClient } from '../redis/redis-client';
import { RedisTickQueue } from './redis-tick-queue';

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required to run live Redis tests');
  return url;
}

describe('RedisTickQueue (live)', () => {
  const REDIS_URL = requireRedisUrl();
  const keyPrefix = `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let producer: ReturnType<typeof buildRedisClient>;
  let subscriber: ReturnType<typeof buildRedisClient>;
  let queue: RedisTickQueue;

  beforeEach(() => {
    producer = buildRedisClient(REDIS_URL);
    subscriber = buildRedisClient(REDIS_URL);
    queue = new RedisTickQueue({ producer, subscriber, keyPrefix });
  });

  afterEach(async () => {
    await producer.del(`${keyPrefix}:queue`);
    try {
      await producer.quit();
    } catch {
      // already closed
    }
    try {
      await subscriber.quit();
    } catch {
      // already closed by consumer.stop()
    }
  });

  it('round-trips a chat payload from producer to consumer', async () => {
    const consumer = queue.consume();
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'hi' });
    const got = await consumer.next();
    console.log('[redis-tq] popped:', got);
    expect(got).toMatchObject({ trigger: 'chat', agentId: 'a1', chatContent: 'hi' });
    await consumer.stop();
  });

  it('hasScheduledFor finds a scheduled payload before it is consumed', async () => {
    await queue.enqueue({ trigger: 'scheduled', agentId: 'a2' });
    expect(await queue.hasScheduledFor('a2')).toBe(true);
    expect(await queue.hasScheduledFor('a3')).toBe(false);

    const consumer = queue.consume();
    await consumer.next();
    expect(await queue.hasScheduledFor('a2')).toBe(false);
    await consumer.stop();
  });

  it('preserves FIFO order across two enqueues', async () => {
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'first' });
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'second' });
    const consumer = queue.consume();
    const a = await consumer.next();
    const b = await consumer.next();
    console.log('[redis-tq] order:', a?.trigger, b?.trigger);
    expect(a).toMatchObject({ chatContent: 'first' });
    expect(b).toMatchObject({ chatContent: 'second' });
    await consumer.stop();
  });

  it('stop() unblocks a waiting consumer with null', async () => {
    const consumer = queue.consume();
    const pending = consumer.next();
    setTimeout(() => void consumer.stop(), 50);
    const got = await pending;
    expect(got).toBeNull();
  });
});
