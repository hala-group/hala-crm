import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { type Principal } from '../../common/auth.types.js';
import { type AuditService } from '../audit/audit.service.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { type AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type ContactRecord, type ConversationRecord, type MediaRecord, type MessageRecord } from './inbox.schema.js';
import { type InboxService } from './inbox.service.js';
import { MessagesService } from './messages.service.js';

describe('MessagesService markRead', () => {
  it('broadcasts the cleared unread count to authorized inbox sessions', async () => {
    const tenantId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const conversation = { _id: conversationId, accountId };
    const view = { _id: conversationId.toString(), tenantId, accountId: accountId.toString(), unreadCount: 0 };
    const sequence: string[] = [];
    const conversations = { updateOne: vi.fn(async () => { sequence.push('clear'); }) };
    const messages = { findOne: vi.fn(() => ({ sort: () => ({ lean: async () => null }) })) };
    const inbox = {
      getConversation: vi.fn(async () => conversation),
      getConversationView: vi.fn(async () => view)
    };
    const bus = { publish: vi.fn(async event => { sequence.push(event.type); }) };
    const service = new MessagesService({} as Model<WhatsAppAccountRecord>, {} as Model<ContactRecord>,
      conversations as unknown as Model<ConversationRecord>, messages as unknown as Model<MessageRecord>,
      {} as Model<MediaRecord>, inbox as unknown as InboxService, {} as AccountCommandService,
      {} as AuditService, bus as unknown as RedisBusService);
    const principal = { tenantId } as Principal;

    await service.markRead(principal, conversationId.toString());

    expect(conversations.updateOne).toHaveBeenCalledWith({ _id: conversationId, accountId }, { $set: { unreadCount: 0 } });
    expect(bus.publish).toHaveBeenCalledWith({ type: 'conversation.updated', tenantId,
      accountId: accountId.toString(), conversation: view });
    expect(sequence).toEqual(['clear', 'conversation.updated']);
  });

  it('broadcasts unread state when marked unread', async () => {
    const tenantId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const conversation = { _id: conversationId, accountId };
    const view = { _id: conversationId.toString(), tenantId, accountId: accountId.toString(), unreadCount: 1 };
    const conversations = { updateOne: vi.fn(async () => {}) };
    const inbox = {
      getConversation: vi.fn(async () => conversation),
      getConversationView: vi.fn(async () => view)
    };
    const bus = { publish: vi.fn(async () => {}) };
    const service = new MessagesService({} as Model<WhatsAppAccountRecord>, {} as Model<ContactRecord>,
      conversations as unknown as Model<ConversationRecord>, {} as Model<MessageRecord>,
      {} as Model<MediaRecord>, inbox as unknown as InboxService, {} as AccountCommandService,
      {} as AuditService, bus as unknown as RedisBusService);
    const principal = { tenantId } as Principal;

    await service.markUnread(principal, conversationId.toString());

    expect(conversations.updateOne).toHaveBeenCalledWith({ _id: conversationId, accountId }, { $set: { unreadCount: 1 } });
    expect(bus.publish).toHaveBeenCalledWith({ type: 'conversation.updated', tenantId,
      accountId: accountId.toString(), conversation: view });
  });
});
