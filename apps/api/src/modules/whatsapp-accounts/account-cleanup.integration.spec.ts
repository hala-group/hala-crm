import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Model, Schema, Types } from 'mongoose';
import { SYSTEM_ROLES, defineAbilityFor } from '@hala/shared';
import { type StorageRegistry } from '@hala/shared/storage';
import { type Principal } from '../../common/auth.types.js';
import { runInTenant } from '../../common/tenant-context.js';
import { tenantPlugin } from '../../common/tenant.plugin.js';
import { accountSchema } from './account.schema.js';
import { AccountsService } from './accounts.service.js';
import { AccountCleanupService } from './account-cleanup.service.js';
import { cleanupMedia } from './cleanup-media.js';

describe('durable account cleanup', () => {
  let mongo: MongoMemoryServer;
  let connection: mongoose.Connection;
  let accounts: ReturnType<typeof createAccounts>;
  let media: Model<Record<string, unknown>>;
  function createAccounts() { return connection.model('CleanupAccount', accountSchema); }
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    connection = await mongoose.createConnection(mongo.getUri()).asPromise();
    accounts = createAccounts();
    const schema = new Schema({ tenantId: Schema.Types.ObjectId, accountId: Schema.Types.ObjectId,
      storageKey: String, thumbnailKey: String, storageDriver: String, status: String }, { strict: false });
    schema.plugin(tenantPlugin);
    media = connection.model('CleanupMedia', schema) as Model<Record<string, unknown>>;
  }, 120_000);
  afterAll(async () => { await connection?.close(); await mongo?.stop(); });

  function principal(tenantId = new Types.ObjectId().toString()): Principal {
    const id = new Types.ObjectId().toString();
    const role = { id: 'owner', name: 'Owner', permissions: [...SYSTEM_ROLES.owner] };
    return { id, tenantId, role, accountMemberships: [], email: '', name: '', status: 'active',
      ability: defineAbilityFor({ id, tenantId }, role, []) };
  }
  function harness(user: Principal) {
    const service = Object.create(AccountsService.prototype) as AccountsService;
    Reflect.set(service, 'accounts', accounts);
    const cleanup = new AccountCleanupService(accounts, service);
    const add = vi.fn(async (_name: string, _task: Parameters<AccountCleanupService['process']>[0], _options: unknown) => ({}));
    Reflect.set(cleanup, 'queue', { add });
    return { service, cleanup, add, inTenant: <T>(work: () => T) => runInTenant(user.tenantId, work) };
  }

  it('returns an accepted job before cleanup, deduplicates repeated clicks, and blocks reconnect', async () => {
    const user = principal(); const h = harness(user);
    await h.inTenant(async () => {
      const account = await accounts.create({ tenantId: user.tenantId, label: 'test', desiredState: 'connected' });
      const result = await h.cleanup.start(user, account.id, 'delete');
      expect(result.accepted).toBe(true);
      expect((await accounts.findById(account.id))?.desiredState).toBe('disconnected');
      expect((await h.cleanup.start(user, account.id, 'delete')).cleanup.id).toBe(result.cleanup.id);
      expect(h.add).toHaveBeenCalledTimes(1);
      await expect(h.service.setConnection(user, account.id, 'connect')).rejects.toThrow('cleanup');
      await expect(h.cleanup.start(user, account.id, 'clear')).rejects.toThrow('already in progress');
    });
  });

  it('allows clear for disconnected accounts, persists failure to queue, and supports explicit retry', async () => {
    const user = principal(); const h = harness(user);
    await h.inTenant(async () => {
      const account = await accounts.create({ tenantId: user.tenantId, label: 'test', status: 'disconnected' });
      h.add.mockRejectedValueOnce(new Error('redis unavailable'));
      await expect(h.cleanup.start(user, account.id, 'clear')).rejects.toThrow('queue unavailable');
      expect((await accounts.findById(account.id))?.cleanup?.state).toBe('failed');
      expect((await h.cleanup.start(user, account.id, 'clear')).cleanup.operation).toBe('clear');
    });
  });

  it('rejects cross-tenant and unmanaged accounts before enqueueing', async () => {
    const owner = principal(); const h = harness(owner);
    const account = await h.inTenant(() => accounts.create({ tenantId: owner.tenantId, label: 'private' }));
    const outsider = principal();
    await runInTenant(outsider.tenantId, () => expect(h.cleanup.start(outsider, account.id, 'delete')).rejects.toThrow('not found'));
    const restricted = { ...owner, ability: defineAbilityFor(owner, { permissions: ['accounts:delete'] }, []) };
    await h.inTenant(() => expect(h.cleanup.start(restricted, account.id, 'delete')).rejects.toThrow());
    expect(h.add).not.toHaveBeenCalled();
  });

  it('persists background failure/progress, resumes through a new job, and ignores a superseded retry', async () => {
    const user = principal(); const h = harness(user);
    const account = await h.inTenant(() => accounts.create({ tenantId: user.tenantId, label: 'test' }));
    await h.inTenant(() => h.cleanup.start(user, account.id, 'delete'));
    const task = h.add.mock.calls[0]![1];
    const remove = vi.spyOn(h.service, 'remove').mockImplementation(async (_user, _id, progress) => {
      await progress?.(3, 10); throw new Error('HOSTINGER_STORAGE_DELETE_503');
    });
    await expect(h.cleanup.process(task)).rejects.toThrow('503');
    await h.inTenant(async () => {
      expect((await accounts.findById(account.id))?.cleanup).toMatchObject({ state: 'failed', processedMedia: 3, totalMedia: 10 });
      const retry = await h.cleanup.start(user, account.id, 'delete');
      expect(retry.cleanup).toMatchObject({ state: 'queued', processedMedia: 3, totalMedia: 10 });
    });
    await h.cleanup.process(task);
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockImplementationOnce(async () => {
      await accounts.deleteOne({ _id: account.id }); return { ok: true };
    });
    await h.cleanup.process(h.add.mock.calls[1]![1]);
    expect(await h.inTenant(() => accounts.findById(account.id).exec())).toBeNull();
  });

  it('offers retry after a crash between persisting the account lock and adding the Redis job', async () => {
    const user = principal(); const h = harness(user);
    await h.inTenant(async () => {
      const account = await accounts.create({ tenantId: user.tenantId, label: 'test', cleanup: {
        id: 'interrupted-job', operation: 'delete', state: 'queued', processedMedia: 0, totalMedia: 0,
        requestedAt: new Date(Date.now() - 60000).toISOString()
      } });
      Reflect.set(h.cleanup, 'queue', { add: h.add, getJob: vi.fn(async () => null) });
      expect((await h.cleanup.list(user))[0]?.cleanup?.state).toBe('failed');
      expect((await h.cleanup.start(user, account.id, 'delete')).accepted).toBe(true);
    });
  });

  it('checkpoints successful assets, retains failed originals/thumbnails and retries within account/tenant boundaries', async () => {
    const user = principal();
    await runInTenant(user.tenantId, async () => {
      const scope = { tenantId: new Types.ObjectId(user.tenantId), accountId: new Types.ObjectId() };
      const otherAccount = new Types.ObjectId();
      await media.create([
        { ...scope, storageKey: 'cleanup/one', thumbnailKey: 'cleanup/thumb', storageDriver: 'hostinger', status: 'failed' },
        ...Array.from({ length: 12 }, (_, i) => ({ ...scope, storageKey: `cleanup/item${i}`, storageDriver: 'hostinger' })),
        { ...scope, accountId: otherAccount, storageKey: 'private/other' }
      ]);
      let shouldFail = true; let active = 0; let maximum = 0;
      const deleted = vi.fn(async (key: string) => {
        active++; maximum = Math.max(maximum, active);
        try { await new Promise(resolve => setTimeout(resolve, 1));
          if (key === 'cleanup/thumb' && shouldFail) throw new Error('HOSTINGER_STORAGE_DELETE_503');
        } finally { active--; }
      });
      const storage = { forDriver: () => ({ delete: deleted }) } as unknown as StorageRegistry;
      const progress = vi.fn(async () => {});
      await expect(cleanupMedia(media, storage, scope, 0, progress)).rejects.toThrow('503');
      const remaining = await media.countDocuments(scope);
      expect(remaining).toBeLessThan(13);
      expect(await media.exists({ ...scope, storageKey: 'cleanup/one' })).not.toBeNull();
      shouldFail = false;
      expect(await cleanupMedia(media, storage, scope, 13, progress)).toBe(13);
      expect(await media.countDocuments(scope)).toBe(0);
      expect(await media.countDocuments({ tenantId: scope.tenantId, accountId: otherAccount })).toBe(1);
      expect(deleted).not.toHaveBeenCalledWith('private/other');
      expect(maximum).toBeLessThanOrEqual(5);
      expect(progress).toHaveBeenLastCalledWith(13, 13);
    });
  });
});
