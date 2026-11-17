import { Redis } from 'ioredis';

export interface Lease { accountId: string; workerId: string; fencingToken: number }
export interface LeaseBackend {
  acquire(accountId: string, workerId: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<boolean>;
  current(accountId: string): Promise<Lease | null>;
}

const acquireScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then return nil end
local token = redis.call('INCR', KEYS[2])
local value = cjson.encode({workerId=ARGV[1], fencingToken=token})
redis.call('SET', KEYS[1], value, 'PX', ARGV[2])
return value`;
const renewScript = `
local value = redis.call('GET', KEYS[1])
if value and cjson.decode(value).workerId == ARGV[1] and cjson.decode(value).fencingToken == tonumber(ARGV[2]) then
  return redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 0`;
const releaseScript = `
local value = redis.call('GET', KEYS[1])
if value and cjson.decode(value).workerId == ARGV[1] and cjson.decode(value).fencingToken == tonumber(ARGV[2]) then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class RedisLeaseBackend implements LeaseBackend {
  constructor(private readonly redis: Redis) {}
  private key(id: string): string { return `lease:account:${id}`; }
  async acquire(accountId: string, workerId: string, ttlMs: number): Promise<Lease | null> {
    const value = await this.redis.eval(acquireScript, 2, this.key(accountId), `fence:account:${accountId}`, workerId, ttlMs);
    if (typeof value !== 'string') return null;
    const parsed = JSON.parse(value) as { workerId: string; fencingToken: number };
    return { accountId, ...parsed };
  }
  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    return Number(await this.redis.eval(renewScript, 1, this.key(lease.accountId), lease.workerId, lease.fencingToken, ttlMs)) === 1;
  }
  async release(lease: Lease): Promise<boolean> {
    return Number(await this.redis.eval(releaseScript, 1, this.key(lease.accountId), lease.workerId, lease.fencingToken)) === 1;
  }
  async current(accountId: string): Promise<Lease | null> {
    const value = await this.redis.get(this.key(accountId));
    if (!value) return null;
    const parsed = JSON.parse(value) as { workerId: string; fencingToken: number };
    return { accountId, ...parsed };
  }
}

export class LeaseService {
  private readonly cachedAssert = new Map<string, { current: Lease | null; expiresAt: number }>();

  constructor(private readonly backend: LeaseBackend, readonly workerId: string, private readonly ttlMs: number) {}
  acquire(id: string): Promise<Lease | null> {
    this.cachedAssert.delete(id);
    return this.backend.acquire(id, this.workerId, this.ttlMs);
  }
  renew(lease: Lease): Promise<boolean> { return this.backend.renew(lease, this.ttlMs); }
  release(lease: Lease): Promise<boolean> {
    this.cachedAssert.delete(lease.accountId);
    return this.backend.release(lease);
  }
  async assertOwned(lease: Lease): Promise<void> {
    const now = Date.now();
    let entry = this.cachedAssert.get(lease.accountId);
    if (!entry || entry.expiresAt <= now) {
      const current = await this.backend.current(lease.accountId);
      entry = { current, expiresAt: now + 1000 };
      this.cachedAssert.set(lease.accountId, entry);
    }
    const current = entry.current;
    if (!current || current.workerId !== lease.workerId || current.fencingToken !== lease.fencingToken) {
      this.cachedAssert.delete(lease.accountId);
      throw new Error('STALE_SESSION_FENCE');
    }
  }
}
