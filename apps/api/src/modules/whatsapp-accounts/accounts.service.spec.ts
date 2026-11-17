import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLES, defineAbilityFor } from '@hala/shared';
import { type Model, Types } from 'mongoose';
import { runInTenant } from '../../common/tenant-context.js';
import { type AuditService } from '../audit/audit.service.js';
import { type AccountAccessService } from '../access/account-access.service.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { type AccountCommandService } from './account-command.service.js';
import { type WhatsAppAccountRecord } from './account.schema.js';
import { AccountsService } from './accounts.service.js';

describe('WhatsApp account chat reset', () => {
  it('deletes an account and all account-owned records after its session stops', async () => {
    const tenantId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const actorId = new Types.ObjectId();
    const lifecycle: string[] = [];
    const account = { _id: accountId, tenantId, desiredState: 'connected',
      save: vi.fn(async () => { lifecycle.push('save-disconnected'); }) };
    const accounts = { findOne: vi.fn(async () => account),
      deleteOne: vi.fn(async () => { lifecycle.push('delete-account'); }),
      db: { collection: vi.fn((name: string) => ({ deleteMany: vi.fn(async () => { lifecycle.push(`delete-${name}`); }) })) }
    } as unknown as Model<WhatsAppAccountRecord>;
    const conversations = { deleteMany: vi.fn(async () => { lifecycle.push('delete-conversations'); return { deletedCount: 3 }; })
    } as unknown as Model<Record<string, unknown>>;
    const messages = { deleteMany: vi.fn(async () => { lifecycle.push('delete-messages'); return { deletedCount: 7 }; })
    } as unknown as Model<Record<string, unknown>>;
    const media = { find: vi.fn(() => ({ select: () => ({ lean: async () => [{ storageKey: 'test/original', thumbnailKey: 'test/thumb' }] }) })),
      deleteMany: vi.fn(async () => { lifecycle.push('delete-media'); })
    } as unknown as Model<Record<string, unknown>>;
    const members = { find: vi.fn(() => ({ lean: async () => [] })),
      deleteMany: vi.fn(async () => { lifecycle.push('delete-members'); })
    } as unknown as Model<Record<string, unknown>>;
    const authStates = { deleteMany: vi.fn(async () => { lifecycle.push('delete-credentials'); })
    } as unknown as Model<Record<string, unknown>>;
    const commands = { send: vi.fn(async () => { lifecycle.push('disconnect-command'); }),
      waitUntilStopped: vi.fn(async () => { lifecycle.push('session-stopped'); return true; })
    } as unknown as AccountCommandService;
    const audit = { record: vi.fn(async () => { lifecycle.push('audit'); }) } as unknown as AuditService;
    const bus = { publish: vi.fn(async () => { lifecycle.push('publish'); }) } as unknown as RedisBusService;
    const service = new AccountsService(accounts, members, authStates, conversations, messages, media,
      {} as Model<Record<string, unknown>>, audit, {} as AccountAccessService, commands, bus);
    const deleteStoredFile = vi.fn(async () => { lifecycle.push('delete-stored-file'); });
    Reflect.set(service, 'storage', { forDriver: vi.fn(() => ({ delete: deleteStoredFile })) });
    const principal = {
      id: actorId.toString(), tenantId: tenantId.toString(), email: 'owner@test.invalid', name: 'Owner',
      status: 'active' as const, role: { id: 'owner', name: 'Owner', permissions: [...SYSTEM_ROLES.owner] },
      ability: defineAbilityFor({ id: actorId.toString(), tenantId: tenantId.toString() },
        { permissions: SYSTEM_ROLES.owner }, []), accountMemberships: []
    };

    expect(await runInTenant(tenantId.toString(), () => service.remove(principal, accountId.toString())))
      .toEqual({ ok: true });
    expect(lifecycle.indexOf('delete-stored-file')).toBeGreaterThan(lifecycle.indexOf('session-stopped'));
    expect(lifecycle.indexOf('delete-messages')).toBeGreaterThan(lifecycle.indexOf('session-stopped'));
    expect(lifecycle.indexOf('delete-account')).toBeGreaterThan(lifecycle.indexOf('delete-messages'));
    expect(lifecycle).toContain('delete-calls');
    expect(lifecycle).toContain('delete-history_cursors');
    expect(audit.record).toHaveBeenCalledWith(actorId.toString(), 'account.delete', 'WhatsAppAccount',
      accountId.toString(), { conversations: 3, messages: 7, media: 1 });
  });

  it('stops the linked session and clears credentials before deleting chats, then requests a fresh QR session', async () => {
    const tenantId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const actorId = new Types.ObjectId();
    const lifecycle: string[] = [];
    const account = {
      _id: accountId, tenantId, label: 'Support', provider: 'baileys', status: 'connected',
      desiredState: 'connected', save: vi.fn(async () => { lifecycle.push(`save:${account.status}`); })
    } as unknown as WhatsAppAccountRecord & { _id: Types.ObjectId; save: () => Promise<void> };
    const accounts = {
      findOne: vi.fn(async () => account),
      db: { collection: vi.fn(() => ({ deleteMany: vi.fn(async () => { lifecycle.push('clear-cursors'); }) })) }
    } as unknown as Model<WhatsAppAccountRecord>;
    const media = {
      find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
      deleteMany: vi.fn(async () => { lifecycle.push('delete-media-records'); })
    } as unknown as Model<Record<string, unknown>>;
    const messages = { deleteMany: vi.fn(async () => { lifecycle.push('delete-messages'); return { deletedCount: 7 }; }) } as unknown as Model<Record<string, unknown>>;
    const conversations = { deleteMany: vi.fn(async () => { lifecycle.push('delete-conversations'); return { deletedCount: 3 }; }) } as unknown as Model<Record<string, unknown>>;
    const authStates = { deleteMany: vi.fn(async () => { lifecycle.push('clear-credentials'); }) } as unknown as Model<Record<string, unknown>>;
    const commands = {
      send: vi.fn(async () => { lifecycle.push('logout-command'); return true; }),
      waitUntilStopped: vi.fn(async () => { lifecycle.push('lease-released'); return true; })
    } as unknown as AccountCommandService;
    const audit = { record: vi.fn(async (_actor: string, action: string) => { lifecycle.push(`audit:${action}`); }) } as unknown as AuditService;
    const service = new AccountsService(accounts, {} as Model<Record<string, unknown>>, authStates,
      conversations, messages, media, {} as Model<Record<string, unknown>>, audit,
      {} as AccountAccessService, commands, {} as RedisBusService);
    const principal = {
      id: actorId.toString(), tenantId: tenantId.toString(), email: 'owner@test.invalid', name: 'Owner',
      status: 'active' as const, role: { id: 'owner', name: 'Owner', permissions: [...SYSTEM_ROLES.owner] },
      ability: defineAbilityFor({ id: actorId.toString(), tenantId: tenantId.toString() },
        { permissions: SYSTEM_ROLES.owner }, []), accountMemberships: []
    };

    const result = await runInTenant(tenantId.toString(), () => service.clearChats(principal, accountId.toString()));

    expect(result).toEqual({ deleted: { conversations: 3, messages: 7, media: 0 } });
    expect(lifecycle.indexOf('logout-command')).toBeGreaterThan(lifecycle.indexOf('save:logged_out'));
    expect(lifecycle.indexOf('lease-released')).toBeGreaterThan(lifecycle.indexOf('logout-command'));
    expect(lifecycle.indexOf('clear-credentials')).toBeGreaterThan(lifecycle.indexOf('lease-released'));
    expect(lifecycle.indexOf('delete-messages')).toBeGreaterThan(lifecycle.indexOf('clear-credentials'));
    expect(lifecycle.indexOf('save:connecting')).toBeGreaterThan(lifecycle.indexOf('clear-cursors'));
    expect(account.desiredState).toBe('connected');
    expect(commands.waitUntilStopped).toHaveBeenCalledWith(accountId.toString(), 15_000);
  });
});
