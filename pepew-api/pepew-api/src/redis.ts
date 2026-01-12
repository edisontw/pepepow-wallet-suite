import * as IORedis from 'ioredis';
import { config } from './config.js';

const RedisCtor: any = (IORedis as any).default || (IORedis as any);

export const redis = config.redisUrl ? new RedisCtor(config.redisUrl) : null;

export async function rget<T>(k: string): Promise<T | undefined> {
  if (!redis) return undefined;
  const s = await redis.get(k);
  return s ? (JSON.parse(s) as T) : undefined;
}

export async function rset<T>(k: string, v: T, ttlMs: number) {
  if (!redis) return;
  await redis.set(k, JSON.stringify(v), 'PX', ttlMs);
}
