import { describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import { type DomainEvent, type MessagePushConfig } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { type AccountAccessService } from '../access/account-access.service.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { type ConversationRecord } from '../inbox/inbox.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { FirebaseMessagingService } from './firebase-messaging.service.js';
import { MessagePushService } from './message-push.service.js';
import { type MessagePushInstallationRecord } from './message-push.schema.js';

const disabledConfig: MessagePushConfig = { enabled: false };

function createService(overrides: {
  installations?: unknown; users?: unknown; roles?: unknown; accounts?: unknown; conversations?: unknown;
  firebase?: unknown; access?: unknown; bus?: unknown;
} = {}) {
  return new MessagePushService(
    (overrides.installations ?? {}) as Model<MessagePushInstallationRecord>,
    (overrides.users ?? {}) as Model<UserRecord>,
    (overrides.roles ?? {}) as Model<RoleRecord>,
    (overrides.accounts ?? {}) as Model<WhatsAppAccountRecord>,
    (overrides.conversations ?? {}) as Model<ConversationRecord>,
    (overrides.firebase ?? { config: () => disabledConfig, isConfigured: () => false }) as FirebaseMessagingService,
    (overrides.access ?? {}) as AccountAccessService,
    (overrides.bus ?? { consume: vi.fn().mockResolvedValue(true) }) as RedisBusService
  );
}

function incomingEvent(overrides: { direction?: 'in' | 'out'; type?: string } = {}): Extract<DomainEvent, { type: 'message.created' }> {
  const tenantId = new Types.ObjectId().toString();
  const accountId = new Types.ObjectId().toString();
  const conversationId = new Types.ObjectId().toString();
  return {
    type: 'message.created', tenantId, accountId, conversationId,
    message: { _id: new Types.ObjectId().toString(), tenantId, accountId, conversationId,
      contactId: new Types.ObjectId().toString(), waMessageId: 'wa-incoming-1',
      direction: overrides.direction ?? 'in', type: (overrides.type ?? 'text') as 'text',
      timestamp: new Date().toISOString(), text: 'private customer text', status: 'delivered' }
  };
}

function createDeliveryHarness(options: { secondConsume?: boolean; unregistered?: boolean } = {}) {
  const event = incomingEvent();
  const allowedId = new Types.ObjectId();
  const deniedId = new Types.ObjectId();
  const allowedRoleId = new Types.ObjectId();
  const deniedRoleId = new Types.ObjectId();
  const accountObjectId = new Types.ObjectId(event.accountId);
  const tenantObjectId = new Types.ObjectId(event.tenantId);
  const users = [
    { _id: allowedId, tenantId: tenantObjectId, roleId: allowedRoleId, status: 'active' },
    { _id: deniedId, tenantId: tenantObjectId, roleId: deniedRoleId, status: 'active' }
  ];
  const userQuery = { select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(users) };
  const roleQuery = { select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([
    { _id: allowedRoleId, permissions: ['conversations:read'] },
    { _id: deniedRoleId, permissions: ['conversations:read'] }
  ]) };
  const conversation = { _id: new Types.ObjectId(event.conversationId), accountId: accountObjectId,
    tenantId: tenantObjectId, assignedUserId: allowedId };
  const conversationQuery = { select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(conversation) };
  const fid = 'firebase-installation-allowed';
  const registration = { _id: new Types.ObjectId(), tenantId: tenantObjectId, userId: allowedId, fid };
  const installations = {
    find: vi.fn(() => ({ lean: async () => [registration] })),
    deleteOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ deletedCount: 1 }) }))
  };
  const sendEachForMulticast = vi.fn().mockResolvedValue({ responses: options.unregistered
    ? [{ success: false, error: { code: 'messaging/installation-id-not-registered' } }]
    : [{ success: true }] });
  const firebase = { config: () => ({ enabled: true }), isConfigured: () => true, sendEachForMulticast };
  let consumes = 0;
  const bus = { consume: vi.fn(async () => { consumes += 1; return options.secondConsume ? consumes === 1 : true; }) };
  const conversations = {
    findOne: vi.fn(() => conversationQuery), exists: vi.fn().mockResolvedValue(true)
  };
  const access = { resolve: vi.fn(async (_tenantId: string, userId: string) => ({
    all: false,
    accounts: userId === allowedId.toString() ? new Map([[event.accountId, 'view' as const]]) : new Map()
  })) };
  const service = createService({ installations, users: { find: vi.fn(() => userQuery) },
    roles: { find: vi.fn(() => roleQuery) }, accounts: { exists: vi.fn().mockResolvedValue(true) },
    conversations, firebase, access, bus });
  return { service, event, allowedId, deniedId, fid, installations, sendEachForMulticast, bus, conversations, access };
}

describe('MessagePushService', () => {
  it('upserts an installation for the authenticated tenant and user', async () => {
    const updateOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ acknowledged: true }) }));
    const service = createService({ firebase: { config: () => disabledConfig, isConfigured: () => true },
      installations: { updateOne } });
    const principal = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() } as Principal;

    await expect(service.subscribe(principal, 'firebase-installation-id-123')).resolves.toEqual({ ok: true });
    expect(updateOne).toHaveBeenCalledWith({ fid: 'firebase-installation-id-123' },
      expect.objectContaining({ $set: { userId: new Types.ObjectId(principal.id), lastRegisteredAt: expect.any(Date) } }), { upsert: true });
  });

  it('sends a generic push only to users who can still read the conversation and claims each event once', async () => {
    const harness = createDeliveryHarness({ secondConsume: true });
    await harness.service.deliver(harness.event);
    await harness.service.deliver(harness.event);

    expect(harness.bus.consume).toHaveBeenCalledWith(
      `message-fcm:${harness.event.tenantId}:${harness.event.accountId}:${harness.event.message.waMessageId}`, 1, 86_400);
    expect(harness.access.resolve).toHaveBeenCalledTimes(2);
    expect(harness.conversations.exists).toHaveBeenCalledOnce();
    expect(harness.installations.find).toHaveBeenCalledWith({
      tenantId: new Types.ObjectId(harness.event.tenantId), userId: { $in: [harness.allowedId] }
    });
    expect(harness.sendEachForMulticast).toHaveBeenCalledOnce();
    const payload = harness.sendEachForMulticast.mock.calls[0]?.[0];
    expect(payload.fids).toEqual([harness.fid]);
    expect(payload.data).toMatchObject({ type: 'message.received', conversationId: harness.event.conversationId,
      url: `/inbox/${harness.event.conversationId}` });
    expect(payload.webpush.notification.data.onActionClick.default).toMatchObject({
      operation: 'navigateLastFocusedOrOpen', url: `/inbox/${harness.event.conversationId}`
    });
    expect(JSON.stringify(payload)).not.toContain('private customer text');
  });

  it('does not send push for outgoing or system messages', async () => {
    const harness = createDeliveryHarness();
    await harness.service.deliver({ ...harness.event, message: { ...harness.event.message, direction: 'out' } });
    await harness.service.deliver({ ...harness.event, message: { ...harness.event.message, type: 'system' } });
    expect(harness.bus.consume).not.toHaveBeenCalled();
    expect(harness.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('removes Firebase installations that are no longer registered', async () => {
    const harness = createDeliveryHarness({ unregistered: true });
    await harness.service.deliver(harness.event);
    expect(harness.installations.deleteOne).toHaveBeenCalledWith({
      tenantId: new Types.ObjectId(harness.event.tenantId), userId: harness.allowedId, fid: harness.fid
    });
  });

  it('refuses registration until Firebase is configured', async () => {
    const service = createService();
    const principal = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() } as Principal;
    await expect(service.subscribe(principal, 'firebase-installation-id-123')).rejects.toThrow('Firebase message push is not configured');
  });
});
