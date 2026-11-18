import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConnection, Types, type Connection, type Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { type DomainEvent } from '@hala/shared';
import { runInTenant } from '../../common/tenant-context.js';
import { type Principal } from '../../common/auth.types.js';
import { type AccountAccessService } from '../access/account-access.service.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { conversationSchema, type ConversationRecord } from '../inbox/inbox.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type FirebaseMessagingService } from './firebase-messaging.service.js';
import { MessagePushService } from './message-push.service.js';
import { messagePushInstallationSchema, type MessagePushInstallationRecord } from './message-push.schema.js';

describe('MessagePushService database integration', () => {
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let installations: Model<MessagePushInstallationRecord>;
  let conversations: Model<ConversationRecord>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    connection = createConnection(mongo.getUri());
    installations = connection.model('MessagePushInstallation', messagePushInstallationSchema);
    conversations = connection.model('Conversation', conversationSchema);
    await Promise.all([installations.init(), conversations.init()]);
  }, 180_000);

  afterAll(async () => {
    try { await connection?.close(); } finally { await mongo?.stop(); }
  });

  it('keeps installations tenant-scoped and upserts ownership on the same tenant', async () => {
    const tenantId = new Types.ObjectId().toString();
    const otherTenantId = new Types.ObjectId().toString();
    const firstUser = new Types.ObjectId().toString();
    const nextUser = new Types.ObjectId().toString();
    const fid = 'same-installation-across-tenant-records';
    const service = new MessagePushService(installations, {} as Model<UserRecord>, {} as Model<RoleRecord>,
      {} as Model<WhatsAppAccountRecord>, {} as Model<ConversationRecord>,
      { isConfigured: () => true } as FirebaseMessagingService, {} as AccountAccessService, {} as RedisBusService);

    await service.subscribe({ id: firstUser, tenantId } as Principal, fid);
    await service.subscribe({ id: nextUser, tenantId } as Principal, fid);
    await service.subscribe({ id: firstUser, tenantId: otherTenantId } as Principal, fid);

    const firstTenantRecords = await runInTenant(tenantId, () => installations.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec());
    const otherTenantRecords = await runInTenant(otherTenantId,
      () => installations.find({ tenantId: new Types.ObjectId(otherTenantId) }).lean().exec());
    expect(firstTenantRecords).toHaveLength(1);
    expect(firstTenantRecords[0]).toMatchObject({ userId: new Types.ObjectId(nextUser), fid });
    expect(otherTenantRecords).toHaveLength(1);
    expect(otherTenantRecords[0]).toMatchObject({ userId: new Types.ObjectId(firstUser), fid });

    await service.unsubscribe({ id: nextUser, tenantId } as Principal, fid);
    const afterUnsubscribe = await runInTenant(tenantId, () => installations.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec());
    expect(afterUnsubscribe).toHaveLength(0);
    const otherTenantAfterUnsubscribe = await runInTenant(otherTenantId,
      () => installations.find({ tenantId: new Types.ObjectId(otherTenantId) }).lean().exec());
    expect(otherTenantAfterUnsubscribe).toHaveLength(1);
  }, 180_000);

  it('queries the stored conversation through current CASL access before sending FIDs', async () => {
    const tenantId = new Types.ObjectId().toString();
    const accountId = new Types.ObjectId().toString();
    const allowedUserId = new Types.ObjectId();
    const deniedUserId = new Types.ObjectId();
    const allowedRoleId = new Types.ObjectId();
    const deniedRoleId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const event: Extract<DomainEvent, { type: 'message.created' }> = {
      type: 'message.created', tenantId, accountId, conversationId: conversationId.toString(),
      message: { _id: new Types.ObjectId().toString(), tenantId, accountId,
        conversationId: conversationId.toString(), contactId: new Types.ObjectId().toString(),
        waMessageId: 'wa-incoming-integration', direction: 'in', type: 'text',
        timestamp: new Date().toISOString(), status: 'delivered' }
    };
    const assignedConversation = await runInTenant(tenantId, () => conversations.create({
      _id: conversationId, tenantId: new Types.ObjectId(tenantId), accountId: new Types.ObjectId(accountId),
      contactId: new Types.ObjectId(), status: 'open', assignedUserId: allowedUserId,
      lastMessageAt: new Date(), lastMessagePreview: '', lastMessageType: 'text', lastMessageDirection: 'in'
    }));
    const allowedFid = `fid-allowed-${new Types.ObjectId().toString()}`;
    const deniedFid = `fid-denied-${new Types.ObjectId().toString()}`;
    await runInTenant(tenantId, () => installations.create([
      { tenantId: new Types.ObjectId(tenantId), userId: allowedUserId, fid: allowedFid },
      { tenantId: new Types.ObjectId(tenantId), userId: deniedUserId, fid: deniedFid }
    ]));
    const users = [
      { _id: allowedUserId, roleId: allowedRoleId, status: 'active' },
      { _id: deniedUserId, roleId: deniedRoleId, status: 'active' }
    ];
    const query = (value: unknown) => ({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(value) });
    const roles = [
      { _id: allowedRoleId, permissions: ['conversations:read'] },
      { _id: deniedRoleId, permissions: ['conversations:read'] }
    ];
    const sent: Array<{ fids: string[] }> = [];
    const firebase = { isConfigured: () => true, sendEachForMulticast: vi.fn(async (message: { fids: string[] }) => {
      sent.push(message);
      return { responses: message.fids.map(() => ({ success: true })) };
    }) };
    const access = { resolve: vi.fn(async (_tenant: string, userId: string) => ({ all: false,
      accounts: userId === allowedUserId.toString() ? new Map([[accountId, 'view' as const]]) : new Map() })) };
    const service = new MessagePushService(installations,
      { find: vi.fn(() => query(users)) } as unknown as Model<UserRecord>,
      { find: vi.fn(() => query(roles)) } as unknown as Model<RoleRecord>,
      { exists: vi.fn().mockResolvedValue(true) } as unknown as Model<WhatsAppAccountRecord>,
      conversations, firebase as unknown as FirebaseMessagingService, access as unknown as AccountAccessService,
      { consume: vi.fn().mockResolvedValue(true) } as unknown as RedisBusService);

    await service.deliver(event);

    expect(sent.map(message => message.fids)).toEqual([[allowedFid]]);
    expect(assignedConversation.assignedUserId?.toString()).toBe(allowedUserId.toString());
    const readableConversation = await runInTenant(tenantId, () => conversations.findOne({
      _id: conversationId, tenantId: new Types.ObjectId(tenantId), accountId: new Types.ObjectId(accountId),
      assignedUserId: deniedUserId
    }).lean().exec());
    expect(readableConversation).toBeNull();
    const deniedTenantInstallations = await runInTenant(new Types.ObjectId().toString(),
      () => installations.find({ tenantId: new Types.ObjectId(tenantId), fid: allowedFid }).lean().exec());
    expect(deniedTenantInstallations).toHaveLength(0);
  }, 180_000);
});
