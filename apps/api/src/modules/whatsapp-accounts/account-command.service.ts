import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type AccountCommand, type HistorySyncCommand, type RefreshAvatarCommand, type RefreshProfileCommand, type OutboundCommand, type WorkerCommand } from '@hala/shared';
import { RedisBusService } from '../access/redis-bus.service.js';

@Injectable()
export class AccountCommandService {
  constructor(@Inject(RedisBusService) private readonly bus: RedisBusService) {}

  async send(command: AccountCommand | HistorySyncCommand | RefreshAvatarCommand | RefreshProfileCommand | OutboundCommand): Promise<boolean> {
    const workerId = await this.bus.leaseOwner(command.accountId);
    if (!workerId) return false;
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const profileQueue = command.type === 'refresh_avatar' || command.type === 'refresh_profile';
    const queue = new Queue<WorkerCommand>(profileQueue ? `wa-avatars-${workerId}` : `wa-commands-${workerId}`, { connection });
    try {
      await queue.add('command', command, { removeOnComplete: true, removeOnFail: 1000,
        ...(profileQueue ? { jobId: `${command.type}-${command.accountId}-${command.contactId}` } : {}) });
      return true;
    } finally {
      await queue.close();
      connection.disconnect();
    }
  }

  async waitUntilStopped(accountId: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (await this.bus.leaseOwner(accountId)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return true;
  }
}
