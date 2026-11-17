import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { type AccessChangedEvent, type AccountDeletedEvent, type ProviderEvent, type DomainEvent } from '@hala/shared';

type BusEvent = AccessChangedEvent | AccountDeletedEvent | ProviderEvent | DomainEvent;

@Injectable()
export class RedisBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisBusService.name);
  private readonly origin = randomUUID();
  private readonly publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000, retryStrategy: () => null });
  private readonly subscriber = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000, retryStrategy: () => null });
  private readonly listeners = new Set<(event: BusEvent) => void | Promise<void>>();
  private readonly localCounters = new Map<string, { count: number; expires: number }>();
  private ready = false;

  constructor() {
    this.publisher.on('error', () => {});
    this.subscriber.on('error', () => {});
  }

  async onModuleInit(): Promise<void> {
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe('hala.events');
      this.subscriber.on('message', (_channel, payload: string) => {
        const { origin, event } = JSON.parse(payload) as { origin?: string; event: BusEvent };
        if (origin !== this.origin) this.dispatch(event);
      });
      this.ready = true;
    } catch {
      this.logger.warn('Redis bus unavailable; account access uses MongoDB directly');
    }
  }

  private dispatch(event: BusEvent): void {
    for (const listener of this.listeners) void Promise.resolve(listener(event)).catch(() => this.logger.error('Redis event listener failed'));
  }

  listen(listener: (event: BusEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: BusEvent): Promise<void> {
    this.dispatch(event);
    if (this.ready) await this.publisher.publish('hala.events', JSON.stringify({ origin: this.origin, event }));
  }

  async get(key: string): Promise<string | null> { return this.ready ? this.publisher.get(key) : null; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.ready) await this.publisher.set(key, value, 'EX', ttlSeconds);
  }
  async del(key: string): Promise<void> { if (this.ready) await this.publisher.del(key); }
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!this.ready) {
      if (process.env.NODE_ENV === 'production') throw new Error('Rate limiter Redis unavailable');
      const previous = this.localCounters.get(key);
      const now = Date.now();
      const next = previous && previous.expires > now ? { ...previous, count: previous.count + 1 } : { count: 1, expires: now + windowSeconds * 1000 };
      this.localCounters.set(key, next);
      return next.count <= limit;
    }
    const result = await this.publisher.eval(
      "local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return count",
      1, key, windowSeconds, limit
    );
    return Number(result) <= limit;
  }
  async ping(): Promise<boolean> { return this.ready && (await this.publisher.ping()) === 'PONG'; }
  async leaseOwner(accountId: string): Promise<string | null> {
    const value = await this.get(`lease:account:${accountId}`);
    if (!value) return null;
    try { return (JSON.parse(value) as { workerId: string }).workerId; } catch { return null; }
  }
  async onModuleDestroy(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
