import { type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { type Server, type ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private publisher?: Redis;
  private subscriber?: Redis;
  private adapter?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) { super(app); }

  async connectToRedis(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const publisher = new Redis(url, { lazyConnect: true, connectTimeout: 1000, retryStrategy: () => null });
    const subscriber = publisher.duplicate();
    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      this.publisher = publisher;
      this.subscriber = subscriber;
      this.adapter = createAdapter(publisher, subscriber);
    } catch {
      publisher.disconnect();
      subscriber.disconnect();
    }
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
  }
}
