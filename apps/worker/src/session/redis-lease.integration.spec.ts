import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { LeaseService, RedisLeaseBackend } from './lease.service.js';

describe('Redis lease fencing', () => {
  it.skipIf(!process.env.REDIS_TEST_URL)('allows one owner, renews atomically, and increments the fence after release', async () => {
    const redis = new Redis(process.env.REDIS_TEST_URL!);
    const id = `test-${randomUUID()}`;
    const first = new LeaseService(new RedisLeaseBackend(redis), 'worker-a', 3000);
    const second = new LeaseService(new RedisLeaseBackend(redis), 'worker-b', 3000);
    try {
      const [a, b] = await Promise.all([first.acquire(id), second.acquire(id)]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const winner = a ? first : second;
      const loser = a ? second : first;
      const lease = a ?? b!;
      expect(await winner.renew(lease)).toBe(true);
      expect(await loser.acquire(id)).toBeNull();
      expect(await winner.release(lease)).toBe(true);
      const next = await loser.acquire(id);
      expect(next?.fencingToken).toBe(lease.fencingToken + 1);
      await expect(winner.assertOwned(lease)).rejects.toThrow('STALE_SESSION_FENCE');
      expect(await winner.release(lease)).toBe(false);
      await loser.release(next!);
    } finally {
      await redis.del(`lease:account:${id}`, `fence:account:${id}`);
      redis.disconnect();
    }
  });
});
