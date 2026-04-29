import IORedis, { type Redis, type RedisOptions } from 'ioredis';

export function buildRedisClient(url: string, opts: RedisOptions = {}): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
}
