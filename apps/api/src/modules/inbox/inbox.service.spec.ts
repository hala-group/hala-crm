import { describe, expect, it, vi } from 'vitest';
import { type Model, Types } from 'mongoose';
import { SYSTEM_ROLES, defineAbilityFor } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type ContactRecord, type ContactAvatarRecord, type ConversationRecord, type MessageRecord, type MediaRecord } from './inbox.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type AccountMemberRecord } from '../whatsapp-accounts/account.schema.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { type AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import { type AuditService } from '../audit/audit.service.js';
import { InboxService } from './inbox.service.js';

function principal(): Principal {
  const id = new Types.ObjectId().toString();
  const tenantId = new Types.ObjectId().toString();
  return { id, tenantId, email: 'owner@test.invalid', name: 'Owner', status: 'active',
    role: { id: 'owner', name: 'Owner', permissions: [...SYSTEM_ROLES.owner] },
    ability: defineAbilityFor({ id, tenantId }, { permissions: SYSTEM_ROLES.owner }, []),
    accountMemberships: [] };
}

function createService(overrides: {
  contacts?: unknown;
  conversations?: unknown;
  accounts?: unknown;
  messages?: unknown;
  media?: unknown;
  avatars?: unknown;
  users?: unknown;
  roles?: unknown;
  members?: unknown;
  bus?: unknown;
  commands?: unknown;
  audit?: unknown;
} = {}) {
  return new InboxService(
    (overrides.contacts ?? {}) as Model<ContactRecord>,
    (overrides.conversations ?? {}) as Model<ConversationRecord>,
    (overrides.accounts ?? {}) as Model<WhatsAppAccountRecord>,
    (overrides.messages ?? {}) as Model<MessageRecord>,
    (overrides.media ?? {}) as Model<MediaRecord>,
    (overrides.avatars ?? {}) as Model<ContactAvatarRecord>,
    (overrides.users ?? {}) as Model<UserRecord>,
    (overrides.roles ?? {}) as Model<RoleRecord>,
    (overrides.members ?? {}) as Model<AccountMemberRecord>,
    (overrides.bus ?? { publish: vi.fn() }) as unknown as RedisBusService,
    (overrides.commands ?? {}) as unknown as AccountCommandService,
    (overrides.audit ?? { record: vi.fn() }) as unknown as AuditService
  );
}

describe('inbox account existence', () => {
  it('renders a legacy current-number name as a real sender name while identifying the account own LID', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const record = { _id: new Types.ObjectId(), tenantId: new Types.ObjectId(user.tenantId), accountId,
      contactId: new Types.ObjectId(), status: 'open', lastMessageAt: new Date(), lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 };
    const contact = { waId: '888888888888@lid', phoneE164: '+201009999999', isSelf: true,
      displayName: 'أنت (الرقم الحالي)', pushName: 'اسم جهة الاتصال' };
    const query = (value: unknown) => ({ select: vi.fn().mockReturnThis(), lean: async () => value });
    const service = createService({ contacts: { find: () => query([]), findOne: () => query(contact) },
      conversations: { findOne: () => query(record) },
      accounts: { findOne: () => query({ _id: accountId, phoneNumber: '201001234567',
        ownJid: '201001234567@s.whatsapp.net', ownLid: '777777777777@lid' }) }
    });
    expect((await service.getConversationView(user, record._id.toString())).contactName).toBe('اسم جهة الاتصال');
    Object.assign(contact, { waId: '777777777777@lid', phoneE164: '+201001234567', isSelf: false,
      displayName: '', pushName: '' });
    expect((await service.getConversationView(user, record._id.toString())).contactName).toBe('أنت (رسائل شخصية)');
  });

  it('renders a shared contact as self only under its own connected account', async () => {
    const user = principal();
    const firstId = new Types.ObjectId(), otherId = new Types.ObjectId(), contactId = new Types.ObjectId();
    const record = { _id: new Types.ObjectId(), tenantId: new Types.ObjectId(user.tenantId), accountId: firstId,
      contactId, status: 'open', lastMessageAt: new Date(), lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 };
    const query = (value: unknown) => ({ select: vi.fn().mockReturnThis(), lean: async () => value });
    const service = createService({
      contacts: { find: () => query([]), findOne: () => query({ waId: '201001234567@s.whatsapp.net',
        isSelf: true, displayName: 'أنت (رسائل شخصية)', pushName: 'الاسم الصحيح' }) },
      conversations: { findOne: () => query(record) },
      accounts: { findOne: (filter: { _id: Types.ObjectId }) => query({ _id: filter._id,
        phoneNumber: filter._id.equals(firstId) ? '201001234567' : '201009999999' }) }
    });
    expect((await service.getConversationView(user, record._id.toString())).contactName).toBe('أنت (رسائل شخصية)');
    record.accountId = otherId;
    expect((await service.getConversationView(user, record._id.toString())).contactName).toBe('الاسم الصحيح');
  });
  it('scopes list queries to existing accounts even for an owner', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const contacts = { find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })) };
    const accounts = { find: vi.fn(() => ({ select: () => ({ lean: async () => [{ _id: accountId }] }) })) };
    const conversations = { find: vi.fn(() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })) };
    const service = createService({ contacts, accounts, conversations });

    expect(await service.list(user, {})).toEqual({ items: [], nextCursor: null });
    const query = conversations.find.mock.calls[0]?.[0];
    expect(query).toMatchObject({ $and: [expect.any(Object),
      { accountId: { $in: [accountId] }, $and: [{ $or: [
        { lastMessageType: { $ne: 'system' } }, { $and: [{ lastCallAt: { $exists: true } }, expect.any(Object)] }
      ] }] }] });
    expect(accounts.find).toHaveBeenCalledWith({ tenantId: user.tenantId });
  });

  it('rejects direct reads of conversations whose account was deleted', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contacts = { find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })) };
    const accounts = { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })) };
    const conversations = { findOne: vi.fn(() => ({ lean: async () => ({ _id: conversationId, accountId }) })) };
    const service = createService({ contacts, accounts, conversations });

    await expect(service.getConversation(user, conversationId.toString())).rejects.toThrow('Conversation not found');
    expect(accounts.findOne).toHaveBeenCalledWith({ _id: accountId, tenantId: user.tenantId });
  });

  it('filters by tag and unreadOnly when requested', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const taggedContactId = new Types.ObjectId();
    const contacts = {
      find: vi.fn((q: Record<string, unknown>) => {
        if (q['tags'] === 'VIP') {
          return { select: () => ({ lean: async () => [{ _id: taggedContactId }] }) };
        }
        return { select: () => ({ lean: async () => [] }) };
      })
    };
    const accounts = { find: vi.fn(() => ({ select: () => ({ lean: async () => [{ _id: accountId }] }) })) };
    const conversations = { find: vi.fn(() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })) };
    const service = createService({ contacts, accounts, conversations });

    await service.list(user, { tag: 'VIP', unreadOnly: 'true' });
    const query = conversations.find.mock.calls[0]?.[0];
    const andArray = query['$and'][1]['$and'];
    expect(andArray).toEqual(expect.arrayContaining([
      { unreadCount: { $gt: 0 } },
      { contactId: { $in: [taggedContactId] } }
    ]));
  });

  it('updates conversation tags and audits the change', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contact = { _id: contactId, tags: ['old'], displayName: 'Test Contact' };
    const conversation = {
      _id: conversationId, accountId, contactId, tenantId: user.tenantId,
      status: 'open', lastMessageAt: new Date(), lastMessageType: 'text',
      lastMessageDirection: 'in', unreadCount: 0, lastMessagePreview: 'hi'
    };
    const contacts = {
      find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
      findOne: vi.fn(() => ({ lean: async () => contact })),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 }))
    };
    const accounts = { findOne: vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: accountId }) }) })) };
    const conversations = {
      findOne: vi.fn(() => ({ lean: async () => conversation }))
    };
    const audit = { record: vi.fn(async () => {}) };
    const bus = { publish: vi.fn(async () => {}) };
    const service = createService({ contacts, accounts, conversations, audit, bus });

    await service.updateTags(user, conversationId.toString(), ['VIP', 'Lead']);
    expect(contacts.updateOne).toHaveBeenCalledWith(
      { _id: contactId, tenantId: user.tenantId },
      { $set: { tags: ['VIP', 'Lead'], updatedAt: expect.any(Date) } }
    );
    expect(audit.record).toHaveBeenCalledWith(
      user.id, 'contacts:update', 'Contact', contactId.toString(),
      { conversationId: conversationId.toString(), tags: ['VIP', 'Lead'] }
    );
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation.updated',
      conversation: expect.objectContaining({ tags: ['old'] })
    }));
  });

  it('archives a conversation and publishes update', async () => {
    const user = principal();
    const accountId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contact = { _id: contactId, tags: [], displayName: 'Test Contact' };
    const conversation = {
      _id: conversationId, accountId, contactId, tenantId: user.tenantId,
      status: 'open', lastMessageAt: new Date(), lastMessageType: 'text',
      lastMessageDirection: 'in', unreadCount: 0, lastMessagePreview: 'hi'
    };
    const contacts = {
      find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
      findOne: vi.fn(() => ({ lean: async () => contact }))
    };
    const accounts = { findOne: vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: accountId }) }) })) };
    const conversations = {
      findOne: vi.fn(() => ({ lean: async () => conversation })),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 }))
    };
    const audit = { record: vi.fn(async () => {}) };
    const bus = { publish: vi.fn(async () => {}) };
    const service = createService({ contacts, accounts, conversations, audit, bus });

    const result = await service.archive(user, conversationId.toString(), true);
    expect(conversations.updateOne).toHaveBeenCalledWith(
      { _id: conversationId },
      { $set: { status: 'archived', updatedAt: expect.any(Date) } }
    );
    expect(audit.record).toHaveBeenCalledWith(
      user.id, 'conversations:archive', 'Conversation', conversationId.toString(),
      { archived: true, status: 'archived' }
    );
    expect(result.status).toBe('archived');
  });
});
