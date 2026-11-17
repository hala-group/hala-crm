import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { contactDisplayName, defineAbilityFor, inboxListQuerySchema, isPermission, messageListQuerySchema,
  messageSearchQuerySchema, type MessageSearchResultView,
  subject, type ConversationView, type MessageView } from '@hala/shared';
import { randomUUID } from 'node:crypto';
import { createStorageRegistry } from '@hala/shared/storage';
import { type Principal } from '../../common/auth.types.js';
import { type ContactRecord, type ContactAvatarRecord, type ConversationRecord, type MediaRecord, type MessageRecord } from './inbox.schema.js';
import { AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import { type UserRecord } from '../users/user.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type AccountMemberRecord } from '../whatsapp-accounts/account.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { AuditService } from '../audit/audit.service.js';

type ConversationDoc = ConversationRecord & { _id: Types.ObjectId };
type MessageDoc = MessageRecord & { _id: Types.ObjectId };
type MediaDoc = MediaRecord & { _id: Types.ObjectId };

@Injectable()
export class InboxService {
  private readonly storage = createStorageRegistry();
  constructor(
    @InjectModel('Contact') private readonly contacts: Model<ContactRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationRecord>,
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('Message') private readonly messages: Model<MessageRecord>,
    @InjectModel('Media') private readonly media: Model<MediaRecord>,
    @InjectModel('ContactAvatar') private readonly avatars: Model<ContactAvatarRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('AccountMember') private readonly members: Model<AccountMemberRecord>,
    private readonly bus: RedisBusService,
    private readonly commands: AccountCommandService,
    private readonly audit: AuditService
  ) {}

  private conversationScope(principal: Principal) { return accessibleBy(principal.ability, 'read').ofType('Conversation'); }
  private messageScope(principal: Principal) { return accessibleBy(principal.ability, 'read').ofType('Message'); }
  private mediaScope(principal: Principal) { return accessibleBy(principal.ability, 'read').ofType('Media'); }

  private async statusFeedContactIds(principal: Principal): Promise<Types.ObjectId[]> {
    const contacts = await this.contacts.find({ tenantId: principal.tenantId, waId: 'status@broadcast' }).select('_id').lean();
    return contacts.map(contact => contact._id);
  }

  private async conversationView(record: ConversationDoc, principal: Principal): Promise<ConversationView> {
    const contact = await this.contacts.findOne({ _id: record.contactId, tenantId: record.tenantId }).lean();
    const canReadCall = principal.ability.can('read', subject('Call', {
      tenantId: record.tenantId.toString(), accountId: record.accountId.toString()
    }));
    return { _id: record._id.toString(), tenantId: record.tenantId.toString(), accountId: record.accountId.toString(),
      contactId: record.contactId.toString(), contactName: contactDisplayName(contact ? { ...contact, isSelf: Boolean(contact.isSelf || contact.displayName === 'أنت (رسائل شخصية)') } : {}),
      contactWaId: contact?.waId ?? '', contactPhoneE164: contact?.phoneE164,
      contactAbout: record.contactAbout, commonGroups: [],
      profileStatus: record.profileStatus, profileCheckedAt: record.profileCheckedAt?.toISOString(),
      status: record.status, assignedUserId: record.assignedUserId?.toString() ?? null,
      lastMessageAt: record.lastMessageAt.toISOString(), lastCallAt: canReadCall ? record.lastCallAt?.toISOString() : undefined,
      lastMessagePreview: record.lastMessagePreview,
      lastMessageType: record.lastMessageType, lastMessageDirection: record.lastMessageDirection,
      lastMessageStatus: record.lastMessageStatus ?? (record.lastMessageDirection === 'out' ? 'delivered' : undefined),
      unreadCount: record.unreadCount,
      tags: contact?.tags ?? [] };
  }

  async list(principal: Principal, raw: unknown) {
    const query = inboxListQuerySchema.parse(raw);
    const filter: Record<string, unknown> = {};
    const conditions: Record<string, unknown>[] = [];
    if (principal.ability.rulesFor('read', 'Call').length) {
      conditions.push({ $or: [{ lastMessageType: { $ne: 'system' } },
        { $and: [{ lastCallAt: { $exists: true } }, accessibleBy(principal.ability, 'read').ofType('Call')] }] });
    } else filter['lastMessageType'] = { $ne: 'system' };
    const activeAccounts = await this.accounts.find({ tenantId: principal.tenantId }).select('_id').lean();
    const accountIds = activeAccounts.map(account => account._id);
    filter['accountId'] = { $in: query.accountId
      ? accountIds.filter(id => id.toString() === query.accountId) : accountIds };
    const statusContactIds = await this.statusFeedContactIds(principal);
    if (statusContactIds.length) filter['contactId'] = { $nin: statusContactIds };
    if (query.status) filter['status'] = query.status;
    if (query.unreadOnly) conditions.push({ unreadCount: { $gt: 0 } });
    if (query.assigned === 'me') filter['assignedUserId'] = principal.id;
    if (query.assigned === 'unassigned') filter['assignedUserId'] = null;
    if (query.tag) {
      const taggedContacts = await this.contacts.find({ tenantId: principal.tenantId, tags: query.tag }).select('_id').lean();
      conditions.push({ contactId: { $in: taggedContacts.map(c => c._id) } });
    }
    if (query.q) {
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      const contacts = await this.contacts.find({ $or: [{ displayName: pattern }, { pushName: pattern },
        { phoneE164: pattern }, { waId: pattern }] }).select('_id').lean();
      conditions.push({ $or: [{ contactId: { $in: contacts.map(contact => contact._id) } }, { lastMessagePreview: pattern }] });
    }
    const canReadCalls = principal.ability.rulesFor('read', 'Call').length > 0;
    if (query.cursor) {
      const [stamp, id] = query.cursor.split('_');
      if (!stamp || !id || !Types.ObjectId.isValid(id)) throw new NotFoundException('Invalid cursor');
      const date = new Date(Number(stamp));
      if (Number.isNaN(date.getTime())) throw new NotFoundException('Invalid cursor');
      const beforeCall = { $or: [{ lastCallAt: { $lt: date } }, { lastCallAt: { $exists: false } }] };
      const atCall = { $or: [{ lastCallAt: { $lte: date } }, { lastCallAt: { $exists: false } }] };
      conditions.push(canReadCalls ? { $or: [
        { $and: [{ lastMessageAt: { $lt: date } }, beforeCall] },
        { $and: [{ lastMessageAt: { $lte: date } }, atCall, { _id: { $lt: new Types.ObjectId(id) } }] }
      ] } : { $or: [{ lastMessageAt: { $lt: date } },
        { lastMessageAt: date, _id: { $lt: new Types.ObjectId(id) } }] });
    }
    if (conditions.length) filter['$and'] = conditions;
    const scope = { $and: [this.conversationScope(principal), filter] };
    const byMessage = await this.conversations.find(scope).sort({ lastMessageAt: -1, _id: -1 }).limit(query.limit + 1).lean();
    const byCall = canReadCalls ? await this.conversations.find({ $and: [this.conversationScope(principal), filter,
      { lastCallAt: { $exists: true } }] }).sort({ lastCallAt: -1, _id: -1 }).limit(query.limit + 1).lean() : [];
    const activityAt = (record: ConversationDoc): Date => canReadCalls && record.lastCallAt && record.lastCallAt > record.lastMessageAt
      ? record.lastCallAt : record.lastMessageAt;
    const records = [...new Map([...byMessage, ...byCall].map(record => [record._id.toString(), record])).values()]
      .sort((a, b) => activityAt(b).getTime() - activityAt(a).getTime() || b._id.toString().localeCompare(a._id.toString()));
    const selected = records.slice(0, query.limit);
    const views = await Promise.all(selected.map(record => this.conversationView(record, principal)));
    const last = selected.at(-1);
    return { items: views, nextCursor: records.length > query.limit && last ? `${activityAt(last).getTime()}_${last._id.toString()}` : null };
  }

  async getConversation(principal: Principal, id: string): Promise<ConversationDoc> {
    const statusContactIds = await this.statusFeedContactIds(principal);
    const record = await this.conversations.findOne({ $and: [
      { _id: id, ...(statusContactIds.length ? { contactId: { $nin: statusContactIds } } : {}) }, this.conversationScope(principal)
    ] }).lean();
    if (!record) throw new NotFoundException('Conversation not found');
    const account = await this.accounts.findOne({ _id: record.accountId, tenantId: principal.tenantId }).select('_id').lean();
    if (!account) throw new NotFoundException('Conversation not found');
    return record;
  }

  async getConversationView(principal: Principal, id: string): Promise<ConversationView> {
    const record = await this.getConversation(principal, id);
    const view = await this.conversationView(record, principal);
    const groupIds = record.commonGroups?.map(group => group.id) ?? [];
    if (!groupIds.length) return view;
    const contacts = await this.contacts.find({ tenantId: principal.tenantId, waId: { $in: groupIds } }).select('_id waId').lean();
    if (!contacts.length) return view;
    const visible = await this.conversations.find({ $and: [this.conversationScope(principal), {
      accountId: record.accountId, contactId: { $in: contacts.map(contact => contact._id) }
    }] }).select('contactId').lean();
    const visibleContactIds = new Set(visible.map(conversation => conversation.contactId.toString()));
    const visibleJids = new Set(contacts.filter(contact => visibleContactIds.has(contact._id.toString())).map(contact => contact.waId));
    view.commonGroups = record.commonGroups?.filter(group => visibleJids.has(group.id))
      .map(group => ({ id: group.id, name: group.name })) ?? [];
    return view;
  }

  async refreshProfile(principal: Principal, id: string): Promise<ConversationView> {
    const conversation = await this.getConversation(principal, id);
    const contact = await this.contacts.findOne({ _id: conversation.contactId, tenantId: principal.tenantId });
    const hasName = Boolean(contact?.displayName || contact?.pushName);
    if (hasName && conversation.profileCheckedAt && Date.now() - conversation.profileCheckedAt.getTime() < 15 * 60_000) {
      return this.getConversationView(principal, id);
    }
    await this.conversations.updateOne({ _id: conversation._id, tenantId: principal.tenantId },
      { $set: { profileStatus: 'pending', profileCheckedAt: new Date() } });
    const queued = await this.commands.send({ type: 'refresh_profile', accountId: conversation.accountId.toString(),
      tenantId: principal.tenantId, contactId: conversation.contactId.toString() });
    if (!queued) await this.conversations.updateOne({ _id: conversation._id, tenantId: principal.tenantId },
      { $set: { profileStatus: 'unavailable' } });
    return this.getConversationView(principal, id);
  }

  async listConversationMedia(principal: Principal, id: string, raw: unknown) {
    const conversation = await this.getConversation(principal, id);
    const query = messageListQuerySchema.parse(raw);
    const filter: Record<string, unknown> = { conversationId: conversation._id, accountId: conversation.accountId,
      mediaId: { $exists: true }, type: { $in: ['image', 'video', 'audio', 'voice', 'document', 'sticker'] },
      hiddenForUserIds: { $ne: new Types.ObjectId(principal.id) } };
    if (query.cursor) {
      const [stamp, cursorId] = query.cursor.split('_');
      if (!stamp || !cursorId || !Types.ObjectId.isValid(cursorId)) throw new NotFoundException('Invalid cursor');
      const date = new Date(Number(stamp));
      if (Number.isNaN(date.getTime())) throw new NotFoundException('Invalid cursor');
      filter['$or'] = [{ timestamp: { $lt: date } }, { timestamp: date, _id: { $lt: new Types.ObjectId(cursorId) } }];
    }
    const records = await this.messages.find({ $and: [this.messageScope(principal), filter] })
      .sort({ timestamp: -1, _id: -1 }).limit(query.limit + 1).lean();
    const selected = records.slice(0, query.limit);
    const items = await Promise.all(selected.map(record => this.messageView(record)));
    const last = selected.at(-1);
    return { items, nextCursor: records.length > query.limit && last ? `${last.timestamp.getTime()}_${last._id.toString()}` : null };
  }

  async avatarStatus(principal: Principal, id: string) {
    const conversation = await this.getConversation(principal, id);
    const avatar = await this.avatars.findOne({ accountId: conversation.accountId, contactId: conversation.contactId }).lean();
    return { status: avatar?.storageKey ? 'ready' : avatar?.status ?? 'missing', checkedAt: avatar?.checkedAt?.toISOString() };
  }

  async refreshAvatar(principal: Principal, id: string) {
    const conversation = await this.getConversation(principal, id);
    const filter = { accountId: conversation.accountId, contactId: conversation.contactId };
    const avatar = await this.avatars.findOne(filter).lean();
    const elapsed = avatar ? Date.now() - avatar.checkedAt.getTime() : Infinity;
    const wait = avatar?.status === 'ready' ? 7 * 86_400_000
      : avatar?.status === 'unavailable' ? 86_400_000
        : avatar?.status === 'pending' ? 120_000 : 300_000;
    if (elapsed < wait) return { status: avatar?.status ?? 'pending' };
    const now = new Date();
    await this.avatars.updateOne(filter, { $set: { status: 'pending', checkedAt: now },
      $setOnInsert: { tenantId: new Types.ObjectId(principal.tenantId) } }, { upsert: true });
    const queued = await this.commands.send({ type: 'refresh_avatar', accountId: conversation.accountId.toString(),
      tenantId: principal.tenantId, contactId: conversation.contactId.toString() });
    if (!queued) {
      await this.avatars.updateOne(filter, { $set: { status: 'failed' } });
      throw new ServiceUnavailableException('WhatsApp number is not connected');
    }
    return { status: 'pending' };
  }

  async openAvatar(principal: Principal, id: string) {
    const conversation = await this.getConversation(principal, id);
    const avatar = await this.avatars.findOne({ accountId: conversation.accountId, contactId: conversation.contactId }).lean();
    if (!avatar?.storageKey || !avatar.storageDriver) throw new NotFoundException('Avatar not found');
    const stored = await this.storage.forDriver(avatar.storageDriver).open(avatar.storageKey);
    return { stream: stored.stream, mimeType: avatar.mimeType ?? 'image/jpeg' };
  }

  async assign(principal: Principal, id: string, userId: string | null): Promise<ConversationView> {
    const conversation = await this.conversations.findOne({ $and: [
      { _id: id }, accessibleBy(principal.ability, 'assign').ofType('Conversation')
    ] });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (userId) {
      const user = await this.users.findById(userId).lean();
      if (!user || user.status !== 'active') throw new BadRequestException('Assignee is not active');
      const role = await this.roles.findById(user.roleId).lean();
      if (!role) throw new BadRequestException('Assignee role missing');
      const membership = await this.members.find({ userId: user._id, accountId: conversation.accountId }).lean();
      const ability = defineAbilityFor({ id: userId, tenantId: principal.tenantId },
        { permissions: role.permissions.filter(isPermission) }, membership.map(item => ({ accountId: item.accountId.toString(), level: item.level })));
      if (!ability.can('read', subject('Conversation', { tenantId: principal.tenantId,
        accountId: conversation.accountId.toString(), assignedUserId: userId }))) throw new ForbiddenException('Assignee lacks account access');
    }
    conversation.assignedUserId = userId ? new Types.ObjectId(userId) : null;
    await conversation.save();
    const view = await this.conversationView(conversation, principal);
    await this.bus.publish({ type: 'conversation.updated', tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(), conversation: view });
    if (userId) await this.bus.publish({ type: 'conversation.assigned', tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(), conversationId: id, assignedUserId: userId, eventId: randomUUID() });
    return view;
  }

  async listMessages(principal: Principal, id: string, raw: unknown) {
    const conversation = await this.getConversation(principal, id);
    const query = messageListQuerySchema.parse(raw);
    const filter: Record<string, unknown> = { conversationId: conversation._id, accountId: conversation.accountId,
      hiddenForUserIds: { $ne: new Types.ObjectId(principal.id) }, type: { $nin: ['system', 'reaction'] } };
    if (query.cursor) {
      const [stamp, cursorId] = query.cursor.split('_');
      if (!stamp || !cursorId || !Types.ObjectId.isValid(cursorId)) throw new NotFoundException('Invalid cursor');
      const date = new Date(Number(stamp));
      if (Number.isNaN(date.getTime())) throw new NotFoundException('Invalid cursor');
      filter['$or'] = [{ timestamp: { $lt: date } }, { timestamp: date, _id: { $lt: new Types.ObjectId(cursorId) } }];
    }
    const records = await this.messages.find({ $and: [this.messageScope(principal), filter] })
      .sort({ timestamp: -1, _id: -1 }).limit(query.limit + 1).lean();
    const selected = records.slice(0, query.limit);
    const targetIds = [
      ...selected.map(record => record.waMessageId),
      ...selected.map(record => record._id.toString()),
      ...selected.map(record => record.clientMessageId).filter((id): id is string => Boolean(id)),
      ...selected.map(record => record.clientMessageId?.replaceAll('-', '').toUpperCase()).filter((id): id is string => Boolean(id)),
    ];
    const reactions = selected.length ? await this.messages.find({ $and: [this.messageScope(principal), {
      conversationId: conversation._id, accountId: conversation.accountId, type: 'reaction',
      'reaction.targetWaMessageId': { $in: targetIds },
      hiddenForUserIds: { $ne: new Types.ObjectId(principal.id) }
    }] }).lean() : [];
    const items = await Promise.all([...selected, ...reactions].map(record => this.messageView(record)));
    const last = selected.at(-1);
    return { items, nextCursor: records.length > query.limit && last ? `${last.timestamp.getTime()}_${last._id.toString()}` : null };
  }

  async messageView(record: MessageDoc): Promise<MessageView> {
    const asset = record.mediaId ? await this.media.findOne({ _id: record.mediaId, tenantId: record.tenantId, accountId: record.accountId }).lean() : null;
    return { _id: record._id.toString(), tenantId: record.tenantId.toString(), accountId: record.accountId.toString(),
      conversationId: record.conversationId.toString(), contactId: record.contactId.toString(), waMessageId: record.waMessageId,
      direction: record.direction, type: record.type, timestamp: record.timestamp.toISOString(), text: record.text,
      clientMessageId: record.clientMessageId, failureReason: record.failureReason,
      editedAt: record.editedAt?.toISOString(), revokedAt: record.revokedAt?.toISOString(),
      caption: record.caption, mediaId: record.mediaId?.toString(), mediaStatus: asset?.status,
      location: record.type === 'location' ? record.location : undefined,
      contacts: record.type === 'contacts' ? record.contacts : undefined,
      poll: record.type === 'poll' ? record.poll : undefined,
      reaction: record.type === 'reaction' ? record.reaction : undefined,
      pollVote: record.type === 'poll_vote' ? record.pollVote : undefined,
      interactive: record.type === 'interactive' ? record.interactive : undefined,
      template: record.type === 'template' ? record.template : undefined,
      quotedWaMessageId: record.quotedWaMessageId, mentions: record.mentions, forwarded: record.forwarded, status: record.status };
  }

  async openMedia(principal: Principal, id: string, thumbnail: boolean) {
    const asset = await this.media.findOne({ $and: [{ _id: id }, this.mediaScope(principal)] }).lean() as MediaDoc | null;
    if (!asset || asset.status !== 'ready') throw new NotFoundException('Media not found');
    if (asset.messageId) {
      const message = await this.messages.findOne({ $and: [{ _id: asset.messageId, accountId: asset.accountId }, this.messageScope(principal)] }).lean();
      if (!message) throw new NotFoundException('Media not found');
      await this.getConversation(principal, message.conversationId.toString());
    }
    const key = thumbnail && asset.thumbnailKey ? asset.thumbnailKey : asset.storageKey;
    return { ...(await this.storage.forDriver(asset.storageDriver).open(key)), mimeType: thumbnail && asset.thumbnailKey ? 'image/jpeg' : asset.mimeType,
      fileName: asset.fileName };
  }

  async updateTags(principal: Principal, id: string, tags: string[]): Promise<ConversationView> {
    const conversation = await this.getConversation(principal, id);
    const cleanTags = [...new Set(tags.map(t => t.trim()).filter(Boolean))].slice(0, 20);
    await this.contacts.updateOne(
      { _id: conversation.contactId, tenantId: principal.tenantId },
      { $set: { tags: cleanTags, updatedAt: new Date() } }
    );
    await this.audit.record(principal.id, 'contacts:update', 'Contact', conversation.contactId.toString(), {
      conversationId: id, tags: cleanTags
    });
    const view = await this.conversationView(conversation, principal);
    await this.bus.publish({
      type: 'conversation.updated',
      tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(),
      conversation: view
    });
    return view;
  }

  async archive(principal: Principal, id: string, archived: boolean): Promise<ConversationView> {
    const conversation = await this.getConversation(principal, id);
    const newStatus = archived ? 'archived' : 'open';
    await this.conversations.updateOne(
      { _id: conversation._id },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );
    await this.audit.record(principal.id, 'conversations:archive', 'Conversation', conversation._id.toString(), {
      archived, status: newStatus
    });
    conversation.status = newStatus;
    const view = await this.conversationView(conversation, principal);
    await this.bus.publish({
      type: 'conversation.updated',
      tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(),
      conversation: view
    });
    return view;
  }

  async getTags(principal: Principal): Promise<{ tags: string[] }> {
    const distinctTags = await this.contacts.distinct('tags', { tenantId: principal.tenantId });
    const tags = (distinctTags as string[]).filter(t => typeof t === 'string' && t.trim().length > 0);
    return { tags: [...new Set(tags)] };
  }

  async searchMessages(principal: Principal, raw: unknown) {
    const query = messageSearchQuerySchema.parse(raw);
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const filter: Record<string, unknown> = {
      $or: [{ text: pattern }, { caption: pattern }],
      type: { $nin: ['system', 'reaction'] },
      hiddenForUserIds: { $ne: new Types.ObjectId(principal.id) }
    };
    if (query.accountId) filter['accountId'] = new Types.ObjectId(query.accountId);
    if (query.conversationId) filter['conversationId'] = new Types.ObjectId(query.conversationId);

    const activeAccounts = await this.accounts.find({ tenantId: principal.tenantId }).select('_id').lean();
    const accountIds = activeAccounts.map(account => account._id);
    if (!filter['accountId']) {
      filter['accountId'] = { $in: accountIds };
    }

    const scope = { $and: [this.messageScope(principal), filter] };
    const records = await this.messages.find(scope)
      .sort({ timestamp: -1, _id: -1 })
      .limit(query.limit)
      .lean();

    const contactIds = [...new Set(records.map(r => r.contactId.toString()))];
    const contacts = await this.contacts.find({
      _id: { $in: contactIds.map(id => new Types.ObjectId(id)) },
      tenantId: principal.tenantId
    }).lean();
    const contactMap = new Map(contacts.map(c => [c._id.toString(), c]));

    const items: MessageSearchResultView[] = records.map(record => {
      const contact = contactMap.get(record.contactId.toString());
      return {
        message: {
          _id: record._id.toString(),
          tenantId: record.tenantId.toString(),
          accountId: record.accountId.toString(),
          conversationId: record.conversationId.toString(),
          contactId: record.contactId.toString(),
          waMessageId: record.waMessageId,
          clientMessageId: record.clientMessageId,
          direction: record.direction,
          type: record.type,
          timestamp: record.timestamp.toISOString(),
          text: record.text,
          caption: record.caption,
          mediaId: record.mediaId?.toString(),
          status: record.status
        },
        contactName: contactDisplayName(contact ? { ...contact, isSelf: Boolean(contact.isSelf || contact.displayName === 'أنت (رسائل شخصية)') } : {}),
        contactWaId: contact?.waId ?? '',
        contactPhoneE164: contact?.phoneE164
      };
    });

    return { items };
  }
}
