import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConnection, Types, type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { type DomainEvent } from '@hala/shared';
import { runInTenant } from '../../common/tenant-context.js';
import { accountSchema } from '../whatsapp-accounts/account.schema.js';
import { userSchema } from '../users/user.schema.js';
import { roleSchema } from '../roles/role.schema.js';
import {
  contactSchema,
  contactAvatarSchema,
  conversationSchema,
  messageSchema,
} from '../inbox/inbox.schema.js';
import { type AccountAccessService } from '../access/account-access.service.js';
import { type AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import {
  MessagePushContentService,
  pushMessagePreview,
  signPushAvatar,
  verifyPushAvatar,
} from './message-push-content.service.js';

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@hala/shared/storage', () => ({
  createStorageRegistry: () => ({ forDriver: () => ({ open }) }),
}));

describe('notification content and private avatar access', () => {
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let service: MessagePushContentService;
  const ids = Object.fromEntries(
    ['tenantId', 'userId', 'accountId', 'conversationId', 'contactId', 'senderId', 'roleId'].map(
      (key) => [key, new Types.ObjectId().toString()],
    ),
  ) as Record<
    'tenantId' | 'userId' | 'accountId' | 'conversationId' | 'contactId' | 'senderId' | 'roleId',
    string
  >;
  const event: Extract<DomainEvent, { type: 'message.created' }> = {
    type: 'message.created',
    tenantId: ids.tenantId,
    accountId: ids.accountId,
    conversationId: ids.conversationId,
    message: {
      _id: new Types.ObjectId().toString(),
      tenantId: ids.tenantId,
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      contactId: ids.contactId,
      direction: 'in',
      waMessageId: 'group-push',
      type: 'text',
      text: 'موعد التسليم غداً',
      status: 'delivered',
      timestamp: new Date().toISOString(),
      sender: { contactId: ids.senderId, name: 'اسم واتساب', waId: '201001234567@s.whatsapp.net' },
    },
  };
  const access = {
    resolve: vi.fn(async () => ({
      all: false,
      accounts: new Map([[ids.accountId, 'view' as const]]),
    })),
  };
  const commands = { send: vi.fn(async () => true) };
  const claims = (
    overrides: Partial<{
      tenantId: string;
      userId: string;
      accountId: string;
      conversationId: string;
      contactId: string;
      expires: number;
    }> = {},
  ) => ({
    tenantId: ids.tenantId,
    userId: ids.userId,
    accountId: ids.accountId,
    conversationId: ids.conversationId,
    contactId: ids.senderId,
    expires: Date.now() + 300000,
    ...overrides,
  });
  const secret = 'notification-avatar-test-secret-at-least-32-characters';
  const token = (overrides: Parameters<typeof claims>[0] = {}) =>
    signPushAvatar(claims(overrides), secret);

  beforeAll(async () => {
    vi.stubEnv('JWT_ACCESS_SECRET', secret);
    mongo = await MongoMemoryServer.create();
    connection = createConnection(mongo.getUri());
    const contacts = connection.model('Contact', contactSchema);
    const avatars = connection.model('ContactAvatar', contactAvatarSchema);
    const conversations = connection.model('Conversation', conversationSchema);
    const messages = connection.model('Message', messageSchema);
    const users = connection.model('User', userSchema);
    const roles = connection.model('Role', roleSchema);
    const accounts = connection.model('WhatsAppAccount', accountSchema);
    service = new MessagePushContentService(
      contacts,
      avatars,
      conversations,
      messages,
      users,
      roles,
      accounts,
      access as unknown as AccountAccessService,
      commands as unknown as AccountCommandService,
    );
    await connection.asPromise();
    await runInTenant(ids.tenantId, async () => {
      await contacts.create([
        { _id: ids.contactId, waId: '12345@g.us', displayName: 'المبيعات', isGroup: true },
        {
          _id: ids.senderId,
          waId: event.message.sender!.waId,
          displayName: 'أحمد',
          pushName: 'اسم واتساب',
          isGroup: false,
        },
      ]);
      await roles.create({ _id: ids.roleId, name: 'Reader', permissions: ['conversations:read'] });
      await users.create({
        _id: ids.userId,
        email: 'reader@example.test',
        name: 'Reader',
        status: 'active',
        roleId: ids.roleId,
      });
      await accounts.create({ _id: ids.accountId, label: 'WhatsApp' });
      await conversations.create({
        _id: ids.conversationId,
        accountId: ids.accountId,
        contactId: ids.contactId,
        assignedUserId: ids.userId,
        lastMessageAt: new Date(),
        lastMessageType: 'text',
        lastMessageDirection: 'in',
      });
      await messages.create({
        _id: event.message._id,
        accountId: ids.accountId,
        conversationId: ids.conversationId,
        contactId: ids.contactId,
        senderContactId: ids.senderId,
        waMessageId: 'group-push',
        direction: 'in',
        type: 'text',
        status: 'delivered',
        timestamp: new Date(),
      });
    });
  }, 180000);
  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
    vi.unstubAllEnvs();
  });

  it('uses the saved sender name, group name and text, and queues a missing photo only once', async () => {
    await runInTenant(ids.tenantId, async () => {
      expect(await service.describe(event, ids.contactId)).toMatchObject({
        title: 'أحمد · المبيعات',
        body: 'موعد التسليم غداً',
        contactId: ids.senderId,
      });
      await service.describe(event, ids.contactId);
      const direct = { ...event, message: { ...event.message, sender: undefined } };
      expect(await service.describe(direct, ids.senderId)).toMatchObject({
        title: 'أحمد',
        body: 'موعد التسليم غداً',
      });
    });
    expect(commands.send).toHaveBeenCalledOnce();
    expect(commands.send).toHaveBeenCalledWith({
      type: 'refresh_avatar',
      tenantId: ids.tenantId,
      accountId: ids.accountId,
      contactId: ids.senderId,
    });
  });

  it('uses captions and media labels, preserves Unicode and bounds the payload', () => {
    expect(
      pushMessagePreview({
        ...event.message,
        type: 'image',
        text: undefined,
        caption: 'صورة الطلب',
      }),
    ).toBe('صورة الطلب');
    expect(pushMessagePreview({ ...event.message, type: 'voice', text: undefined })).toBe(
      'رسالة صوتية',
    );
    expect(pushMessagePreview({ ...event.message, text: 'سطر\nثان' })).toBe('سطر ثان');
    const preview = pushMessagePreview({ ...event.message, text: '😀'.repeat(1000) });
    expect(Array.from(preview)).toHaveLength(201);
    expect(preview.endsWith('😀…')).toBe(true);
    expect(pushMessagePreview({ ...event.message, revokedAt: new Date().toISOString() })).toBe(
      'تم حذف الرسالة',
    );
  });

  it('rejects tampering, expired links and incorrect signing keys', () => {
    const signed = token();
    expect(verifyPushAvatar(signed, secret).userId).toBe(ids.userId);
    expect(() => verifyPushAvatar(`${signed}x`, secret)).toThrow();
    expect(() => verifyPushAvatar(signed, 'wrong-key')).toThrow();
    expect(() => verifyPushAvatar(token({ expires: Date.now() - 1 }), secret)).toThrow();
  });

  it('opens only a cached photo tied to a currently readable group message', async () => {
    await expect(service.openAvatar(token())).resolves.toBeNull();
    await runInTenant(ids.tenantId, () =>
      connection
        .model('ContactAvatar')
        .updateOne(
          { accountId: ids.accountId, contactId: ids.senderId },
          {
            $set: {
              status: 'ready',
              storageKey: 'private-sender-photo',
              storageDriver: 'local',
              mimeType: 'image/jpeg',
            },
          },
        )
        .exec(),
    );
    open.mockResolvedValue({ stream: Readable.from(Buffer.from('photo')), size: 5 });
    await expect(service.openAvatar(token())).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(open).toHaveBeenLastCalledWith('private-sender-photo');
    const count = open.mock.calls.length;
    await expect(
      service.openAvatar(token({ contactId: new Types.ObjectId().toString() })),
    ).rejects.toThrow();
    await expect(
      service.openAvatar(token({ accountId: new Types.ObjectId().toString() })),
    ).rejects.toThrow();
    await expect(
      service.openAvatar(token({ tenantId: new Types.ObjectId().toString() })),
    ).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(count);
  });

  it('rejects a valid link after membership, assignment or user status changes', async () => {
    const signed = token();
    const count = open.mock.calls.length;
    access.resolve.mockResolvedValueOnce({ all: false, accounts: new Map() });
    await expect(service.openAvatar(signed)).rejects.toThrow();
    await runInTenant(ids.tenantId, () =>
      connection
        .model('Conversation')
        .updateOne({ _id: ids.conversationId }, { $set: { assignedUserId: new Types.ObjectId() } })
        .exec(),
    );
    await expect(service.openAvatar(signed)).rejects.toThrow();
    await runInTenant(ids.tenantId, () =>
      connection
        .model('Conversation')
        .updateOne({ _id: ids.conversationId }, { $set: { assignedUserId: ids.userId } })
        .exec(),
    );
    await runInTenant(ids.tenantId, () =>
      connection
        .model('User')
        .updateOne({ _id: ids.userId }, { $set: { status: 'suspended' } })
        .exec(),
    );
    await expect(service.openAvatar(signed)).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(count);
  });
});
