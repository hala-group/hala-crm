import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { type Model } from 'mongoose';
import { defineAbilityFor, type AccountCleanupAccepted, type AccountCleanupView, type AccountView } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { currentRequestMeta, runInTenant } from '../../common/tenant-context.js';
import { errorDiagnostics } from '../../common/error-diagnostics.js';
import { AccountsService } from './accounts.service.js';
import { type WhatsAppAccountRecord } from './account.schema.js';

interface CleanupTask {
  accountId: string; cleanupId: string; operation: AccountCleanupView['operation'];
  principal: Omit<Principal, 'ability' | 'email' | 'name' | 'status'>;
  meta: { ip?: string; userAgent?: string };
}

@Injectable()
export class AccountCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountCleanupService.name);
  private producer?: Redis;
  private consumer?: Redis;
  private queue?: Queue<CleanupTask>;
  private worker?: Worker<CleanupTask>;
  private initializing?: Promise<void>;

  constructor(@InjectModel('WhatsAppAccount') private readonly model: Model<WhatsAppAccountRecord>,
    @Inject(AccountsService) private readonly accounts: AccountsService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureQueue().catch(() => this.logger.warn('Account cleanup requires Redis; requests will return 503 until it recovers'));
  }

  private ensureQueue(): Promise<void> {
    if (this.queue) return Promise.resolve();
    this.initializing ??= this.initializeQueue().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  private async initializeQueue(): Promise<void> {
    this.producer = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1, connectTimeout: 1000, enableOfflineQueue: false, lazyConnect: true
    });
    this.producer.on('error', () => {});
    try { await this.producer.connect(); }
    catch (error) { this.producer.disconnect(); this.producer = undefined; throw error; }
    this.consumer = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    this.consumer.on('error', () => {});
    this.queue = new Queue<CleanupTask>('account-cleanup', { connection: this.producer });
    this.worker = new Worker<CleanupTask>('account-cleanup', job => this.process(job.data,
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1)), {
      connection: this.consumer, concurrency: 2
    });
    this.worker.on('error', () => this.logger.error('Account cleanup queue unavailable'));
    this.worker.on('failed', job => {
      if (!job) return;
      void job.getState().then(state => {
        if (state !== 'failed') return;
        return runInTenant(job.data.principal.tenantId, () => this.model.updateOne({
          _id: job.data.accountId, 'cleanup.id': job.data.cleanupId
        }, { $set: { 'cleanup.state': 'failed' } }).exec());
      }).catch(() => this.logger.error('Could not persist cleanup failure'));
    });
  }

  async list(principal: Principal): Promise<AccountView[]> {
    const accounts = await this.accounts.list(principal);
    if (!this.queue && accounts.some(account => account.cleanup)) await this.ensureQueue().catch(() => {});
    for (const account of accounts) {
      const cleanup = account.cleanup;
      if (!cleanup || cleanup.state === 'failed' || !this.queue) continue;
      try {
        const job = await this.queue.getJob(cleanup.id);
        const state = job ? await job.getState() : 'missing';
        const missing = state === 'missing' && Date.now() - Date.parse(cleanup.requestedAt ?? '') > 15_000;
        if (state !== 'failed' && !missing) continue;
        await this.model.updateOne({ $and: [{ _id: account._id, 'cleanup.id': cleanup.id },
          accessibleBy(principal.ability, 'read').ofType('WhatsAppAccount')] },
        { $set: { 'cleanup.state': 'failed', 'cleanup.errorCode': 'CLEANUP_FAILED' } });
        cleanup.state = 'failed'; cleanup.errorCode = 'CLEANUP_FAILED';
      } catch { /* A queue outage does not turn a running cleanup into a new task. */ }
    }
    return accounts;
  }

  async start(principal: Principal, id: string, operation: AccountCleanupView['operation']): Promise<AccountCleanupAccepted> {
    const action = operation === 'delete' ? 'delete' : 'update';
    const account = await this.accounts.get(principal, id, action);
    if (operation === 'clear' && account.provider !== 'baileys') {
      throw new UnprocessableEntityException('History reimport requires a linked WhatsApp account');
    }
    if (account.cleanup && account.cleanup.state !== 'failed') {
      if (account.cleanup.operation !== operation) throw new ConflictException('Account cleanup already in progress');
      return { accepted: true, cleanup: account.cleanup };
    }
    if (account.cleanup && account.cleanup.operation !== operation) throw new ConflictException('Retry the existing cleanup first');
    if (!this.queue) await this.ensureQueue().catch(() => {});
    if (!this.queue) throw new ServiceUnavailableException('Account cleanup queue unavailable');
    const cleanup: AccountCleanupView = { id: randomUUID(), operation, state: 'queued', requestedAt: new Date().toISOString(),
      processedMedia: account.cleanup?.processedMedia ?? 0, totalMedia: account.cleanup?.totalMedia ?? 0 };
    const locked = await this.model.findOneAndUpdate({ $and: [
      { _id: id, $or: [{ cleanup: { $exists: false } }, { 'cleanup.state': 'failed' }] },
      accessibleBy(principal.ability, action).ofType('WhatsAppAccount')
    ] }, { $set: { cleanup, desiredState: 'disconnected' } }, { returnDocument: 'after' });
    if (!locked) throw new ConflictException('Account cleanup already in progress');
    try {
      await this.queue.add('cleanup', { accountId: id, cleanupId: cleanup.id, operation,
        principal: { id: principal.id, tenantId: principal.tenantId, role: principal.role,
          accountMemberships: principal.accountMemberships }, meta: currentRequestMeta() }, {
        jobId: cleanup.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 }
      });
    } catch {
      await this.model.updateOne({ _id: id, 'cleanup.id': cleanup.id }, {
        $set: { 'cleanup.state': 'failed', 'cleanup.errorCode': 'CLEANUP_QUEUE_UNAVAILABLE' }
      });
      throw new ServiceUnavailableException('Account cleanup queue unavailable');
    }
    return { accepted: true, cleanup };
  }

  async process(task: CleanupTask, finalAttempt = true): Promise<void> {
    await runInTenant(task.principal.tenantId, async () => {
      const principal: Principal = { ...task.principal, email: '', name: '', status: 'active',
        ability: defineAbilityFor(task.principal, task.principal.role, task.principal.accountMemberships) };
      const action = task.operation === 'delete' ? 'delete' : 'update';
      const scope = { $and: [{ _id: task.accountId, 'cleanup.id': task.cleanupId },
        accessibleBy(principal.ability, action).ofType('WhatsAppAccount')] };
      const account = await this.model.findOneAndUpdate(scope, { $set: { 'cleanup.state': 'running' },
        $unset: { 'cleanup.errorCode': '' } }, { returnDocument: 'after' });
      if (!account) return; // An already completed or superseded job is harmless on replay.
      const progress = async (processedMedia: number, totalMedia: number): Promise<void> => {
        await this.model.updateOne(scope, { $set: { 'cleanup.processedMedia': processedMedia, 'cleanup.totalMedia': totalMedia } });
      };
      try {
        if (task.operation === 'delete') await this.accounts.remove(principal, task.accountId, progress);
        else await this.accounts.clearChats(principal, task.accountId, progress);
      } catch (error) {
        const errorCode = error instanceof ConflictException ? 'CLEANUP_SESSION_STOPPING' : 'CLEANUP_FAILED';
        await this.model.updateOne(scope, { $set: { 'cleanup.state': finalAttempt ? 'failed' : 'running', 'cleanup.errorCode': errorCode } });
        this.logger.error({ ...errorDiagnostics(error), cleanupId: task.cleanupId, errorCode }, 'Account cleanup attempt failed');
        throw error;
      }
    }, task.meta);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
  }
}
