import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { ThrottlerException } from '@nestjs/throttler';
import { BAILEYS_CAPABILITIES, CLOUD_API_CAPABILITIES, outgoingMessageSchema, subject,
  type MessageType, type OutgoingMessageInput, type ProviderCapability } from '@hala/shared';
import { createStorageRegistry } from '@hala/shared/storage';
import { type Principal } from '../../common/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type ContactRecord, type ConversationRecord, type MediaRecord, type MessageRecord } from './inbox.schema.js';
import { InboxService } from './inbox.service.js';

type ConversationDoc = ConversationRecord & { _id: Types.ObjectId };
type MessageDoc = MessageRecord & { _id: Types.ObjectId };
type MediaDoc = MediaRecord & { _id: Types.ObjectId };
const mediaTypes = new Set<MessageType>(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

function jidFor(to: string): string {
  if (/^[1-9]\d{5,15}@s\.whatsapp\.net$/.test(to) || /^\d+@g\.us$/.test(to) || /^\d+@lid$/.test(to)) return to;
  const digits = to.replace(/[+\s()-]/g, '');
  if (!/^[1-9]\d{5,15}$/.test(digits)) throw new UnprocessableEntityException('Invalid WhatsApp destination');
  return `${digits}@s.whatsapp.net`;
}

@Injectable()
export class MessagesService {
  private readonly storage = createStorageRegistry();
  constructor(
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('Contact') private readonly contacts: Model<ContactRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationRecord>,
    @InjectModel('Message') private readonly messages: Model<MessageRecord>,
    @InjectModel('Media') private readonly media: Model<MediaRecord>,
    private readonly inbox: InboxService,
    private readonly commands: AccountCommandService,
    private readonly audit: AuditService,
    private readonly bus: RedisBusService
  ) {}

  private async account(principal: Principal, id: string) {
    const account = await this.accounts.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'read').ofType('WhatsAppAccount')] });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  private assertCapability(provider: 'baileys' | 'cloud_api', capability: ProviderCapability): void {
    const supported = provider === 'baileys' ? BAILEYS_CAPABILITIES : CLOUD_API_CAPABILITIES;
    if (!supported.includes(capability)) throw new UnprocessableEntityException({ code: 'UNSUPPORTED_BY_PROVIDER', capability });
  }

  private async resolveConversation(principal: Principal, input: OutgoingMessageInput): Promise<ConversationDoc> {
    if (input.conversationId) {
      const conversation = await this.inbox.getConversation(principal, input.conversationId);
      if (conversation.accountId.toString() !== input.accountId) throw new NotFoundException('Conversation not found');
      return conversation;
    }
    const waId = jidFor(input.to!);
    let contact = await this.contacts.findOne({ waId });
    if (!contact) {
      try { contact = await this.contacts.create({ tenantId: new Types.ObjectId(principal.tenantId), waId,
        phoneE164: waId.endsWith('@s.whatsapp.net') ? `+${waId.split('@')[0]}` : undefined,
        isGroup: waId.endsWith('@g.us'), tags: [], customFields: {} }); }
      catch { contact = await this.contacts.findOne({ waId }); }
    }
    if (!contact) throw new Error('Contact create failed');
    let conversation = await this.conversations.findOne({ accountId: input.accountId, contactId: contact._id });
    if (!conversation) {
      try { conversation = await this.conversations.create({ tenantId: new Types.ObjectId(principal.tenantId),
        accountId: new Types.ObjectId(input.accountId), contactId: contact._id, status: 'open',
        lastMessageAt: new Date(), lastMessagePreview: '', lastMessageType: input.type,
        lastMessageDirection: 'out', unreadCount: 0 }); }
      catch { conversation = await this.conversations.findOne({ accountId: input.accountId, contactId: contact._id }); }
    }
    if (!conversation) throw new Error('Conversation create failed');
    return conversation;
  }

  private async validateRelated(principal: Principal, conversation: ConversationDoc, id: string): Promise<MessageDoc> {
    const record = await this.messages.findOne({ $and: [{ _id: id, conversationId: conversation._id },
      accessibleBy(principal.ability, 'read').ofType('Message')] }).lean();
    if (!record) throw new NotFoundException('Related message not found');
    return record;
  }

  private async queue(principal: Principal, message: MessageDoc, operation: 'send' | 'edit' | 'revoke' | 'forward' | 'read' = 'send'): Promise<void> {
    let sent = false;
    try { sent = await this.commands.send({ type: 'outbound', operation, tenantId: principal.tenantId,
      accountId: message.accountId.toString(), messageId: message._id.toString() }); }
    catch { sent = false; }
    if (!sent) {
      if (operation === 'send' || operation === 'forward') {
        await this.messages.updateOne({ _id: message._id }, { $set: { status: 'failed', failureReason: 'ACCOUNT_NOT_RUNNING' } });
        const conversation = await this.conversations.findOne({ _id: message.conversationId, accountId: message.accountId }).lean();
        await this.bus.publish({ type: 'message.status', tenantId: principal.tenantId, accountId: message.accountId.toString(),
          conversationId: message.conversationId.toString(), assignedUserId: conversation?.assignedUserId?.toString() ?? null,
          messageId: message._id.toString(), status: 'failed', failureReason: 'ACCOUNT_NOT_RUNNING' });
      }
      throw new ServiceUnavailableException({ code: 'ACCOUNT_NOT_RUNNING', messageId: message._id.toString() });
    }
  }

  async send(principal: Principal, raw: unknown, forwarded = false) {
    const parsed = outgoingMessageSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => issue.message).join('; '));
    const input = parsed.data;
    const account = await this.account(principal, input.accountId);
    if (!principal.ability.can('send', subject('Message', { tenantId: principal.tenantId, accountId: input.accountId }))) throw new ForbiddenException('Reply access required');
    this.assertCapability(account.provider, input.type);
    if (input.replyToMessageId) this.assertCapability(account.provider, 'reply');
    if (input.mentions?.length) this.assertCapability(account.provider, 'mentions');
    if (forwarded) this.assertCapability(account.provider, 'forward');
    if (mediaTypes.has(input.type)) {
      if (!principal.ability.can('send_media', subject('Message', { tenantId: principal.tenantId, accountId: input.accountId }))) throw new ForbiddenException('Media send denied');
      const asset = await this.media.findOne({ _id: 'mediaId' in input ? input.mediaId : undefined, accountId: input.accountId, status: 'ready' });
      if (!asset) throw new NotFoundException('Media not found');
    }
    const existing = await this.messages.findOne({ accountId: input.accountId, clientMessageId: input.clientMessageId }).lean();
    if (existing) return this.inbox.messageView(existing);
    if (!(await this.bus.consume(`rate:send:${principal.tenantId}:${principal.id}:${input.accountId}`, 60, 60))) {
      throw new ThrottlerException('Message rate limit exceeded');
    }
    const conversation = await this.resolveConversation(principal, input);
    if (!principal.ability.can('read', subject('Conversation', { tenantId: principal.tenantId,
      accountId: input.accountId, assignedUserId: conversation.assignedUserId ?? null }))) throw new ForbiddenException('Conversation not accessible');
    const quoted = input.replyToMessageId ? await this.validateRelated(principal, conversation, input.replyToMessageId) : undefined;
    const reaction = input.type === 'reaction' ? await this.validateRelated(principal, conversation, input.targetMessageId) : undefined;
    const now = new Date();
    const preview = input.type === 'text' ? input.text : 'caption' in input ? input.caption ?? '' : '';
    let message: MessageDoc;
    try {
      message = await this.messages.create({ tenantId: new Types.ObjectId(principal.tenantId), accountId: account._id,
        conversationId: conversation._id, contactId: conversation.contactId, clientMessageId: input.clientMessageId,
        waMessageId: input.clientMessageId.replaceAll('-', '').toUpperCase(), direction: 'out', type: input.type,
        text: input.type === 'text' ? input.text : undefined, caption: 'caption' in input ? input.caption : undefined,
        mediaId: 'mediaId' in input ? new Types.ObjectId(input.mediaId) : undefined,
        location: input.type === 'location' ? { lat: input.lat, lng: input.lng, name: input.name, address: input.address } : undefined,
        contacts: input.type === 'contacts' ? input.contacts : undefined,
        poll: input.type === 'poll' ? { question: input.question,
          options: input.options.map((text, index) => ({ id: String(index), text })), selectableCount: input.selectableCount } : undefined,
        interactive: input.type === 'interactive' ? { kind: input.kind, body: input.body,
          responseJson: JSON.stringify(input.data ?? {}) } : undefined,
        template: input.type === 'template' ? { name: input.name, language: input.language,
          componentsJson: JSON.stringify(input.components ?? []) } : undefined,
        reaction: reaction ? { targetWaMessageId: reaction.waMessageId, emoji: input.type === 'reaction' ? input.emoji : '' } : undefined,
        quotedWaMessageId: quoted?.waMessageId, mentions: input.mentions, forwarded,
        outbound: input, status: 'pending', statusHistory: [{ status: 'pending', at: now }],
        sentByUserId: new Types.ObjectId(principal.id), timestamp: now });
    } catch (error) {
      const duplicate = await this.messages.findOne({ accountId: input.accountId, clientMessageId: input.clientMessageId }).lean();
      if (duplicate) return this.inbox.messageView(duplicate);
      throw error;
    }
    if ('mediaId' in input) {
      const claimed = await this.media.findOneAndUpdate({ _id: input.mediaId, accountId: account._id,
        messageId: null, status: 'ready' }, { $set: { messageId: message._id } });
      if (!claimed) {
        await this.messages.deleteOne({ _id: message._id, accountId: account._id });
        throw new ConflictException('Media already used');
      }
    }
    if (input.type !== 'reaction') await this.conversations.updateOne({ _id: conversation._id, accountId: account._id, lastMessageAt: { $lte: now } },
      { $set: { lastMessageAt: now, lastMessagePreview: preview, lastMessageType: input.type,
        lastMessageDirection: 'out', lastMessageStatus: 'pending' } });
    await this.audit.record(principal.id, 'message.send', 'Message', message._id.toString(), { accountId: input.accountId, type: input.type });
    await this.bus.publish({ type: input.type === 'reaction' ? 'message.updated' : 'message.created', tenantId: principal.tenantId, accountId: input.accountId,
      conversationId: conversation._id.toString(), assignedUserId: conversation.assignedUserId?.toString() ?? null,
      message: await this.inbox.messageView(message) });
    await this.queue(principal, message, forwarded ? 'forward' : 'send');
    return this.inbox.messageView(message);
  }

  private async ownedMessage(principal: Principal, id: string, action: 'edit' | 'delete' | 'send' = 'send') {
    const message = await this.messages.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, action).ofType('Message')] }).lean();
    if (!message) throw new NotFoundException('Message not found');
    await this.inbox.getConversation(principal, message.conversationId.toString());
    return message;
  }

  async edit(principal: Principal, id: string, text: string) {
    const message = await this.ownedMessage(principal, id, 'edit');
    if (message.direction !== 'out' || message.type !== 'text' || message.status === 'failed' || Date.now() - message.timestamp.getTime() > 15 * 60_000) {
      throw new UnprocessableEntityException('Message cannot be edited');
    }
    const account = await this.account(principal, message.accountId.toString());
    this.assertCapability(account.provider, 'edit');
    await this.messages.updateOne({ _id: message._id }, { $set: { pendingEditText: text } });
    await this.audit.record(principal.id, 'message.edit', 'Message', id, { accountId: message.accountId.toString() });
    await this.queue(principal, message, 'edit');
    return { accepted: true };
  }

  async remove(principal: Principal, id: string, scope: 'everyone' | 'me') {
    const message = await this.ownedMessage(principal, id, 'delete');
    await this.audit.record(principal.id, 'message.delete', 'Message', id, { scope, accountId: message.accountId.toString() });
    if (scope === 'me') {
      await this.messages.updateOne({ _id: id }, { $addToSet: { hiddenForUserIds: new Types.ObjectId(principal.id) } });
      return { deleted: true };
    }
    const account = await this.account(principal, message.accountId.toString());
    this.assertCapability(account.provider, 'revoke');
    if (message.direction !== 'out' || message.status === 'failed') throw new UnprocessableEntityException('Message cannot be revoked');
    await this.queue(principal, message, 'revoke');
    return { accepted: true };
  }

  private async cloneMedia(principal: Principal, source: MediaDoc, accountId: string): Promise<string> {
    const read = await this.storage.forDriver(source.storageDriver).open(source.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const id = new Types.ObjectId();
    const key = `${principal.tenantId}/${accountId}/${id.toString()}/original`;
    await this.storage.put(key, bytes, source.mimeType);
    const cloned = await this.media.create({ _id: id, tenantId: new Types.ObjectId(principal.tenantId), accountId: new Types.ObjectId(accountId),
      mimeType: source.mimeType, size: bytes.length, fileName: source.fileName, storageKey: key,
      storageDriver: this.storage.defaultDriver, sha256: source.sha256, status: 'ready' });
    return cloned._id.toString();
  }

  async forward(principal: Principal, id: string, conversationIds: string[]) {
    const source = await this.ownedMessage(principal, id);
    const output = [];
    for (const conversationId of conversationIds) {
      const conversation = await this.inbox.getConversation(principal, conversationId);
      if (!principal.ability.can('send', subject('Message', { tenantId: principal.tenantId,
        accountId: conversation.accountId.toString() }))) throw new ForbiddenException('Reply access required');
      const core = { accountId: conversation.accountId.toString(), conversationId, clientMessageId: randomUUID() };
      let body: unknown;
      if (source.type === 'text') body = { ...core, type: 'text', text: source.text ?? '[text]' };
      else if (mediaTypes.has(source.type) && source.mediaId) {
        const asset = await this.media.findOne({ _id: source.mediaId, accountId: source.accountId }).lean();
        if (!asset) throw new NotFoundException('Source media not found');
        const mediaId = await this.cloneMedia(principal, asset, conversation.accountId.toString());
        body = { ...core, type: source.type, mediaId, caption: source.caption };
      } else if (source.type === 'location' && source.location) body = { ...core, type: 'location', ...source.location };
      else if (source.type === 'contacts' && source.contacts) body = { ...core, type: 'contacts', contacts: source.contacts };
      else if (source.type === 'poll' && source.poll) body = { ...core, type: 'poll', question: source.poll.question,
        options: source.poll.options.map(option => option.text), selectableCount: source.poll.selectableCount };
      else body = { ...core, type: 'text', text: source.text ?? source.caption ?? `[${source.type}]` };
      output.push(await this.send(principal, body, true));
    }
    await this.audit.record(principal.id, 'message.forward', 'Message', id, { count: conversationIds.length });
    return output;
  }

  async retry(principal: Principal, id: string) {
    const message = await this.ownedMessage(principal, id);
    if (message.direction !== 'out' || message.status !== 'failed' || !message.outbound) throw new ConflictException('Message cannot be retried');
    await this.messages.updateOne({ _id: message._id }, { $set: { status: 'pending' }, $unset: { failureReason: '' } });
    await this.audit.record(principal.id, 'message.retry', 'Message', id, { accountId: message.accountId.toString() });
    await this.queue(principal, message);
    return { accepted: true };
  }

  async markRead(principal: Principal, conversationId: string) {
    const conversation = await this.inbox.getConversation(principal, conversationId);
    await this.conversations.updateOne({ _id: conversation._id, accountId: conversation.accountId }, { $set: { unreadCount: 0 } });
    const conversationView = await this.inbox.getConversationView(principal, conversationId);
    await this.bus.publish({ type: 'conversation.updated', tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(), conversation: conversationView });
    const latest = await this.messages.findOne({ conversationId: conversation._id, direction: 'in' }).sort({ timestamp: -1 }).lean();
    if (latest) await this.queue(principal, latest, 'read');
    return { read: true };
  }

  async markUnread(principal: Principal, conversationId: string) {
    const conversation = await this.inbox.getConversation(principal, conversationId);
    await this.conversations.updateOne({ _id: conversation._id, accountId: conversation.accountId }, { $set: { unreadCount: 1 } });
    const conversationView = await this.inbox.getConversationView(principal, conversationId);
    await this.bus.publish({ type: 'conversation.updated', tenantId: principal.tenantId,
      accountId: conversation.accountId.toString(), conversation: conversationView });
    return { unread: true };
  }
}
