import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` — with a finite value the
 * blocking commands a worker uses will throw during a Redis blip instead of
 * reconnecting, and jobs get abandoned mid-flight.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

let shared: Redis | undefined;

export function sharedConnection(): Redis {
  shared ??= createRedisConnection();
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
