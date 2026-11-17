import { createHash } from 'node:crypto';
import { type Connection, Types } from 'mongoose';
import sharp from 'sharp';
import { contactDisplayName, normalizedInboundSchema, type DomainEvent, type MediaSource, type MessageMutation, type MessageView,
  type NormalizedInboundMessage, type ProviderContact } from '@hala/shared';
import { type StorageDriver, type StoragePort } from '@hala/shared/storage';

interface Dependencies {
  connection: Connection;
  storage: StoragePort;
  storageDriver?: StorageDriver;
  storageForDriver?: (driver: StorageDriver) => StoragePort;
  download: (source: MediaSource, message?: NormalizedInboundMessage) => Promise<Buffer>;
  publish: (event: DomainEvent) => Promise<void>;
}

interface PendingMutation {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; eventWaMessageId: string; targetWaMessageId: string;
  mutation: MessageMutation; timestamp: Date; createdAt: Date;
}

export class InboundProcessor {
  constructor(private readonly deps: Dependencies) {}

  async syncContact(event: { tenantId: string; accountId: string; contact: ProviderContact }): Promise<void> {
    const { contact } = event;
    const isGroup = contact.id.endsWith('@g.us');
    const lid = [contact.lid, contact.id].find(id => id?.endsWith('@lid'));
    const jid = [contact.jid, contact.id].find(id => id?.endsWith('@s.whatsapp.net'));
    const ids = [...new Set([contact.id, lid, jid].filter((id): id is string => Boolean(id)))];
    if (!ids.length || (!isGroup && !ids.some(id => id.endsWith('@lid') || id.endsWith('@s.whatsapp.net')))) return;
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const db = this.deps.connection.db!;
    if (!await db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId })) return;
    const contacts = db.collection('contacts');
    const existing = await contacts.find({ tenantId, $or: [{ waId: { $in: ids } }, ...(lid ? [{ lid }] : [])] }).toArray();
    const name = contact.name?.trim();
    const notify = contact.notify?.trim();
    const phone = jid?.match(/^([1-9][0-9]{5,15})@s\.whatsapp\.net$/);
    const fields = { ...(name ? { displayName: name } : {}), ...(notify && !isGroup ? { pushName: notify } : {}),
      ...(phone ? { phoneE164: `+${phone[1]}` } : {}), updatedAt: new Date() };
    if (!existing.length) {
      const waId = isGroup ? contact.id : (lid ?? jid ?? contact.id);
      await contacts.updateOne({ tenantId, waId }, { $set: fields,
        $setOnInsert: { ...(lid ? { lid } : {}), createdAt: new Date(), isGroup, tags: [], customFields: {} } }, { upsert: true });
    } else {
      await contacts.updateMany({ tenantId, _id: { $in: existing.map(item => item._id) } }, { $set: { ...fields, ...(isGroup ? { isGroup: true } : {}) } });
    }
    if (lid && !await contacts.findOne({ tenantId, lid })) {
      const phoneContact = existing.find(item => item['waId'] === jid);
      if (phoneContact) await contacts.updateOne({ tenantId, _id: phoneContact._id }, { $set: { lid } });
      else await contacts.updateOne({ tenantId, waId: lid }, { $set: { lid } });
    }
    const matched = existing.length ? existing : await contacts.find({ tenantId, waId: lid ?? jid ?? contact.id }).toArray();
    for (const item of matched) {
      const conversations = await db.collection('conversations').find({ tenantId, accountId, contactId: item._id }).toArray();
      for (const conversation of conversations) {
        await this.deps.publish({ type: 'conversation.updated', tenantId: event.tenantId, accountId: event.accountId,
          conversation: { _id: conversation._id.toString(), tenantId: event.tenantId, accountId: event.accountId,
            contactId: item._id.toString(), contactName: contactDisplayName({ ...item, ...fields, isGroup: Boolean(item['isGroup'] || isGroup), isSelf: Boolean(item['isSelf'] || (fields as Record<string, unknown>)['isSelf']) }),
            contactWaId: item['waId'] as string, status: conversation['status'] as 'open' | 'archived',
            assignedUserId: conversation['assignedUserId']?.toString() ?? null,
            lastMessageAt: (conversation['lastMessageAt'] as Date).toISOString(),
            lastMessagePreview: conversation['lastMessagePreview'] as string,
            lastMessageType: conversation['lastMessageType'] as NormalizedInboundMessage['type'],
            lastMessageDirection: conversation['lastMessageDirection'] as 'in' | 'out',
            unreadCount: conversation['unreadCount'] as number } });
      }
    }
  }

  async syncMessageReadState(event: { tenantId: string; accountId: string; waMessageId: string }): Promise<void> {
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const db = this.deps.connection.db!;
    const message = await db.collection('messages').findOne({ tenantId, accountId, waMessageId: event.waMessageId,
      direction: 'in', status: 'read' });
    if (!message) return;
    const contact = await db.collection('contacts').findOne({ tenantId, _id: message['contactId'] });
    if (!contact?.['waId']) return;
    await this.syncChatReadState({ tenantId: event.tenantId, accountId: event.accountId,
      chatId: contact['waId'] as string, isUnread: false, readThroughWaMessageId: event.waMessageId });
  }

  async syncChatReadState(event: { tenantId: string; accountId: string; chatId: string; isUnread: boolean;
    unreadCount?: number; readThroughWaMessageId?: string }): Promise<void> {
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const db = this.deps.connection.db!;
    if (!await db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId })) return;
    const phone = event.chatId.match(/^([1-9][0-9]{5,15})@s\.whatsapp\.net$/);
    const identities = [{ waId: event.chatId }, { lid: event.chatId }, ...(phone ? [{ phoneE164: `+${phone[1]}` }] : [])];
    const contact = await db.collection('contacts').findOne({ tenantId, $or: identities });
    if (!contact) return;
    const conversations = db.collection('conversations');
    const scope = { tenantId, accountId, contactId: contact._id };
    const conversation = await conversations.findOne(scope);
    if (!conversation) return;
    if (event.readThroughWaMessageId) {
      const latestInbound = await db.collection('messages').findOne({ tenantId, accountId,
        conversationId: conversation._id, direction: 'in', type: { $nin: ['system', 'reaction'] } },
      { sort: { timestamp: -1, _id: -1 } });
      if (latestInbound?.['waMessageId'] !== event.readThroughWaMessageId) return;
    }
    const currentUnreadCount = Number(conversation['unreadCount'] ?? 0);
    const unreadCount = event.unreadCount !== undefined
      ? event.unreadCount
      : (event.isUnread ? Math.max(currentUnreadCount, 1) : 0);
    if (currentUnreadCount === unreadCount) return;
    const updated = await conversations.updateOne({ ...scope, unreadCount: currentUnreadCount },
      { $set: { unreadCount, updatedAt: new Date() } });
    if (!updated.modifiedCount) return;
    const refreshed = await conversations.findOne(scope);
    if (!refreshed) return;
    await this.deps.publish({ type: 'conversation.updated', tenantId: event.tenantId, accountId: event.accountId,
      conversation: { _id: refreshed._id.toString(), tenantId: event.tenantId, accountId: event.accountId,
        contactId: contact._id.toString(), contactName: contactDisplayName({ displayName: contact['displayName'] as string | undefined,
          pushName: contact['pushName'] as string | undefined, phoneE164: contact['phoneE164'] as string | undefined,
          waId: contact['waId'] as string, isGroup: Boolean(contact['isGroup']), isSelf: Boolean(contact['isSelf']) }),
        contactWaId: contact['waId'] as string, ...(contact['phoneE164'] ? { contactPhoneE164: contact['phoneE164'] as string } : {}),
        contactAbout: refreshed['contactAbout'] as string | null | undefined,
        commonGroups: (refreshed['commonGroups'] as { id: string; name: string }[] | undefined) ?? [],
        profileStatus: refreshed['profileStatus'] as 'pending' | 'ready' | 'unavailable' | 'failed' | undefined,
        profileCheckedAt: refreshed['profileCheckedAt'] instanceof Date ? (refreshed['profileCheckedAt'] as Date).toISOString() : undefined,
        status: refreshed['status'] as 'open' | 'archived', assignedUserId: refreshed['assignedUserId']?.toString() ?? null,
        lastMessageAt: (refreshed['lastMessageAt'] as Date).toISOString(),
        lastMessagePreview: refreshed['lastMessagePreview'] as string,
        lastMessageType: refreshed['lastMessageType'] as NormalizedInboundMessage['type'],
        lastMessageDirection: refreshed['lastMessageDirection'] as 'in' | 'out', unreadCount } });
  }

  async ensureIndexes(): Promise<void> {
    const db = this.deps.connection.db!;
    await Promise.all([
      db.collection('contacts').createIndex({ tenantId: 1, waId: 1 }, { unique: true }),
      db.collection('conversations').createIndex({ tenantId: 1, accountId: 1, contactId: 1 }, { unique: true }),
      db.collection('messages').createIndex({ tenantId: 1, accountId: 1, waMessageId: 1 }, { unique: true }),
      db.collection('pending_message_mutations').createIndex({ tenantId: 1, accountId: 1, eventWaMessageId: 1 }, { unique: true }),
      db.collection('pending_message_mutations').createIndex({ tenantId: 1, accountId: 1, targetWaMessageId: 1 }),
      db.collection('media').createIndex({ tenantId: 1, accountId: 1, messageId: 1 },
        { unique: true, partialFilterExpression: { messageId: { $type: 'objectId' } } })
    ]);
  }

  async process(input: NormalizedInboundMessage): Promise<void> {
    const data = normalizedInboundSchema.parse(input);
    const db = this.deps.connection.db!;
    const tenantId = new Types.ObjectId(data.tenantId);
    const accountId = new Types.ObjectId(data.accountId);
    const account = await db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId });
    if (!account) throw new Error('Account missing or cross-tenant');
    if (data.mutation) {
      const now = new Date();
      await db.collection<PendingMutation>('pending_message_mutations').updateOne(
        { tenantId, accountId, eventWaMessageId: data.waMessageId },
        { $setOnInsert: { tenantId, accountId, eventWaMessageId: data.waMessageId,
          targetWaMessageId: data.mutation.targetWaMessageId, mutation: data.mutation, timestamp: data.timestamp, createdAt: now } },
        { upsert: true });
      await this.applyPendingMutations(db, tenantId, accountId, data.mutation.targetWaMessageId);
      return;
    }
    if (data.waId === 'status@broadcast') return;
    const contacts = db.collection('contacts');
    const conversations = db.collection('conversations');
    const messages = db.collection('messages');
    const media = db.collection('media');
    const now = new Date();
    const lidOwner = data.lid ? await contacts.findOne({ tenantId, lid: data.lid }) : null;
    const contactFilter = lidOwner ? { tenantId, _id: lidOwner._id } : { tenantId, waId: data.waId };
    const isSelfContact = Boolean(data.isSelf || lidOwner?.['isSelf']);
    await contacts.updateOne(contactFilter, { $set: {
      ...(!data.isGroup && data.pushName?.trim() ? { pushName: data.pushName.trim() } : {}),
      ...(data.lid && (!lidOwner || lidOwner['waId'] === data.waId) ? { lid: data.lid } : {}),
      ...(data.phoneE164 ? { phoneE164: data.phoneE164 } : {}),
      ...(isSelfContact ? { isSelf: true, displayName: 'أنت (رسائل شخصية)', pushName: 'أنت' } : {}),
      updatedAt: now
    },
    $setOnInsert: { createdAt: now, isGroup: data.isGroup, tags: [], customFields: {} } }, { upsert: true });
    const contact = await contacts.findOne(contactFilter);
    if (!contact) throw new Error('Contact upsert failed');
    const conversationFilter = { tenantId, accountId, contactId: contact._id };
    const preview = data.text?.trim() || data.caption?.trim() || '';
    const visibleMessage = data.type !== 'system' && data.type !== 'reaction';
    await conversations.updateOne(conversationFilter, { $setOnInsert: {
      status: 'open', unreadCount: 0, lastMessageAt: data.timestamp, lastMessagePreview: preview,
      lastMessageType: data.type, lastMessageDirection: data.direction, createdAt: now, updatedAt: now
    } }, { upsert: true });
    const conversation = await conversations.findOne(conversationFilter);
    if (!conversation) throw new Error('Conversation upsert failed');
    const messageFilter = { tenantId, accountId, waMessageId: data.waMessageId };
    const insert = await messages.updateOne(messageFilter, { $setOnInsert: {
      tenantId, accountId, conversationId: conversation._id, contactId: contact._id,
      waMessageId: data.waMessageId, direction: data.direction, type: data.type,
      text: data.text, caption: data.caption, location: data.location, contacts: data.contacts,
      poll: data.poll, pollVote: data.pollVote, interactive: data.interactive, template: data.template,
      reaction: data.reaction, quotedWaMessageId: data.quotedWaMessageId,
      mentions: data.mentions, forwarded: data.forwarded, raw: data.raw, timestamp: data.timestamp,
      status: data.direction === 'out' ? 'sent' : 'delivered', statusHistory: [], createdAt: now, updatedAt: now
    } }, { upsert: true });
    const message = await messages.findOne(messageFilter);
    if (!message) throw new Error('Message upsert failed');
    const callStub = data.raw?.stubType;
    if (callStub === 40 || callStub === 41 || callStub === 45 || callStub === 46) {
      const isVideo = callStub === 41 || callStub === 46;
      await db.collection('calls').updateOne(
        { tenantId, accountId, waCallId: data.waMessageId },
        {
          $setOnInsert: {
            tenantId, accountId, contactId: contact._id, waCallId: data.waMessageId,
            direction: 'in', isVideo, status: 'missed',
            startedAt: data.timestamp, endedAt: data.timestamp, createdAt: now
          },
          $set: { updatedAt: now }
        },
        { upsert: true }
      );
    }
    if (!insert.upsertedCount && data.history && (data.text || data.caption || data.mediaSource || data.type !== message['type']) &&
      !message['text'] && !message['caption'] && !message['mediaId']) {
      await messages.updateOne({ ...messageFilter, text: { $in: [null, ''] }, caption: { $in: [null, ''] }, mediaId: null },
        { $set: { type: data.type, text: data.text, caption: data.caption, raw: data.raw, updatedAt: now } });
      if (visibleMessage) await conversations.updateOne({ ...conversationFilter,
        $or: [{ lastMessageType: 'system' }, { lastMessageAt: { $lte: data.timestamp } }] },
      { $set: { lastMessageAt: data.timestamp, lastMessageDirection: data.direction,
        lastMessageType: data.type, lastMessagePreview: preview, updatedAt: now } });
    }
    if (data.type === 'reaction' && (insert.upsertedCount || (message['reaction'] as Record<string, unknown> | undefined)?.['emoji'] !== data.reaction?.emoji)) {
      await messages.updateOne(messageFilter, { $set: { reaction: data.reaction, updatedAt: now } });
      await this.deps.publish({ type: 'message.updated', tenantId: data.tenantId,
        accountId: data.accountId, conversationId: conversation._id.toString(),
        assignedUserId: conversation['assignedUserId']?.toString() ?? null,
        message: { _id: message._id.toString(), tenantId: data.tenantId, accountId: data.accountId,
          conversationId: conversation._id.toString(), contactId: contact._id.toString(),
          waMessageId: data.waMessageId, direction: data.direction, type: 'reaction',
          timestamp: data.timestamp.toISOString(), reaction: data.reaction,
          status: data.direction === 'out' ? 'sent' : 'delivered' } });
    }
    if (insert.upsertedCount) {
      await conversations.updateOne(conversationFilter, {
        ...(visibleMessage && data.direction === 'in' && !data.history ? { $inc: { unreadCount: 1 } } : {}),
        $set: { updatedAt: now, ...(visibleMessage && data.direction === 'in' ? { status: 'open' } : {}) }
      });
      if (visibleMessage) await conversations.updateOne({ ...conversationFilter,
        $or: [{ lastMessageType: 'system' }, { lastMessageAt: { $lte: data.timestamp } }] }, { $set: {
        lastMessageAt: data.timestamp, lastMessagePreview: preview, lastMessageType: data.type,
        lastMessageDirection: data.direction,
        lastMessageStatus: data.direction === 'out' ? 'sent' : undefined
      } });
      const latest = await conversations.findOne(conversationFilter);
      const assignedUserId = latest?.['assignedUserId']?.toString() ?? null;
      if (visibleMessage && !data.history) await this.deps.publish({ type: 'message.created', tenantId: data.tenantId, accountId: data.accountId,
        conversationId: conversation._id.toString(), assignedUserId,
        message: { _id: message._id.toString(), tenantId: data.tenantId, accountId: data.accountId,
          conversationId: conversation._id.toString(), contactId: contact._id.toString(), waMessageId: data.waMessageId,
          direction: data.direction, type: data.type, timestamp: data.timestamp.toISOString(),
          text: data.text, caption: data.caption, location: data.location, contacts: data.contacts,
          poll: data.poll, pollVote: data.pollVote, interactive: data.interactive, template: data.template,
          reaction: data.reaction, quotedWaMessageId: data.quotedWaMessageId,
          mentions: data.mentions, forwarded: data.forwarded, status: data.direction === 'out' ? 'sent' : 'delivered' } });
      if (visibleMessage) await this.deps.publish({ type: 'conversation.updated', tenantId: data.tenantId, accountId: data.accountId,
        conversation: { _id: conversation._id.toString(), tenantId: data.tenantId, accountId: data.accountId,
          contactId: contact._id.toString(), contactName: contactDisplayName({ displayName: contact['displayName'],
            pushName: contact['pushName'], phoneE164: contact['phoneE164'], waId: data.waId, isGroup: data.isGroup,
            isSelf: Boolean(data.isSelf || contact['isSelf']) }),
          contactWaId: data.waId, status: latest?.['status'] ?? 'open', assignedUserId,
          tags: contact['tags'] ?? [],
          lastMessageAt: latest?.['lastMessageAt']?.toISOString() ?? data.timestamp.toISOString(),
          lastMessagePreview: latest?.['lastMessagePreview'] ?? preview, lastMessageType: latest?.['lastMessageType'] ?? data.type,
          lastMessageDirection: latest?.['lastMessageDirection'] ?? data.direction,
          lastMessageStatus: latest?.['lastMessageStatus'] ?? (latest?.['lastMessageDirection'] === 'out' ? 'sent' : undefined),
          unreadCount: latest?.['unreadCount'] ?? 0 } });
    }
    if (data.mediaSource && !(message['clientMessageId'] && message['mediaId'])) {
      const prefix = `${data.tenantId}/${data.accountId}/${message._id.toString()}`;
      const key = `${prefix}/original`;
      await media.updateOne({ tenantId, accountId, messageId: message._id }, { $setOnInsert: {
        tenantId, accountId, messageId: message._id, storageKey: key,
        storageDriver: this.deps.storageDriver ?? (process.env.STORAGE_DRIVER === 's3' ? 's3' : process.env.STORAGE_DRIVER === 'hostinger' ? 'hostinger' : 'local'),
        mimeType: data.mediaSource.mimeType, fileName: data.mediaSource.fileName,
        status: 'pending', createdAt: now, updatedAt: now
      } }, { upsert: true });
      const asset = await media.findOne({ tenantId, accountId, messageId: message._id });
      if (asset) await messages.updateOne({ _id: message._id, tenantId, accountId }, { $set: { mediaId: asset._id } });
      if (asset && asset['status'] !== 'ready') {
        try {
          const bytes = await this.deps.download(data.mediaSource, data);
          await this.deps.storage.put(key, bytes, data.mediaSource.mimeType);
          let thumbnailKey: string | undefined;
          if (data.mediaSource.kind === 'image' || data.mediaSource.kind === 'sticker') {
            thumbnailKey = `${prefix}/thumb`;
            const thumbnail = await sharp(bytes).resize(320, 320, { fit: 'inside' }).jpeg().toBuffer();
            await this.deps.storage.put(thumbnailKey, thumbnail, 'image/jpeg');
          }
          await media.updateOne({ _id: asset._id, tenantId, accountId }, { $set: { status: 'ready', size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailKey, updatedAt: new Date() } });
          await this.deps.publish({ type: 'message.media_ready', tenantId: data.tenantId, accountId: data.accountId,
            conversationId: conversation._id.toString(), assignedUserId: conversation['assignedUserId']?.toString() ?? null,
            messageId: message._id.toString(), mediaId: asset._id.toString() });
        } catch (error) {
          await media.updateOne({ _id: asset._id, tenantId, accountId }, { $set: { status: 'failed', updatedAt: new Date() } });
          throw error;
        }
      }
    }
    await this.applyPendingMutations(db, tenantId, accountId, data.waMessageId);
  }

  private async applyPendingMutations(db: NonNullable<Connection['db']>, tenantId: Types.ObjectId,
    accountId: Types.ObjectId, targetWaMessageId: string): Promise<void> {
    const pending = db.collection<PendingMutation>('pending_message_mutations');
    const updates = await pending.find({ tenantId, accountId, targetWaMessageId }).sort({ timestamp: 1 }).toArray();
    for (const item of updates) {
      const messages = db.collection('messages');
      const target = await messages.findOne({ tenantId, accountId, waMessageId: targetWaMessageId });
      if (!target) continue;
      const now = new Date();
      if (item.mutation.kind === 'edit') {
        await messages.updateOne({ _id: target._id, tenantId, accountId }, { $set: {
          type: 'text', text: item.mutation.text, editedAt: item.timestamp, updatedAt: now
        }, $unset: { caption: '' } });
      } else {
        const asset = target['mediaId'] ? await db.collection('media').findOne({ _id: target['mediaId'], tenantId, accountId }) : null;
        if (asset) {
          const driver = asset['storageDriver'];
          const storage = driver === 'local' || driver === 's3' || driver === 'hostinger'
            ? this.deps.storageForDriver?.(driver) ?? this.deps.storage : this.deps.storage;
          await storage.delete(asset['storageKey'] as string);
          if (asset['thumbnailKey']) await storage.delete(asset['thumbnailKey'] as string);
          await db.collection('media').deleteOne({ _id: asset._id, tenantId, accountId });
        }
        await messages.updateOne({ _id: target._id, tenantId, accountId }, { $set: {
          revokedAt: item.timestamp, updatedAt: now
        }, $unset: { text: '', caption: '', mediaId: '', location: '', contacts: '', poll: '', pollVote: '',
          interactive: '', template: '', reaction: '' } });
      }
      await pending.deleteOne({ _id: item._id, tenantId, accountId });
      const updated = await messages.findOne({ _id: target._id, tenantId, accountId });
      if (updated) await this.publishMutationUpdate(db, tenantId, accountId, updated);
    }
  }

  private async publishMutationUpdate(db: NonNullable<Connection['db']>, tenantId: Types.ObjectId,
    accountId: Types.ObjectId, record: Record<string, unknown> & { _id: Types.ObjectId }): Promise<void> {
    const conversationId = record['conversationId'] as Types.ObjectId;
    const contactId = record['contactId'] as Types.ObjectId;
    const conversation = await db.collection('conversations').findOne({ _id: conversationId, tenantId, accountId });
    if (!conversation) return;
    const latest = await db.collection('messages').find({ tenantId, accountId, conversationId: conversation._id,
      type: { $ne: 'system' } }).sort({ timestamp: -1, _id: -1 }).limit(1).next();
    if (latest) await db.collection('conversations').updateOne({ _id: conversation._id, tenantId, accountId }, { $set: {
      lastMessageAt: latest['timestamp'], lastMessageType: latest['type'], lastMessageDirection: latest['direction'],
      lastMessagePreview: latest['revokedAt'] ? 'تم حذف الرسالة' : latest['text'] ?? latest['caption'] ?? '', updatedAt: new Date()
    } });
    const message: MessageView = { _id: record._id.toString(), tenantId: tenantId.toString(), accountId: accountId.toString(),
      conversationId: record['conversationId']!.toString(), contactId: record['contactId']!.toString(),
      waMessageId: record['waMessageId'] as string, direction: record['direction'] as 'in' | 'out',
      type: record['type'] as MessageView['type'], timestamp: (record['timestamp'] as Date).toISOString(),
      text: record['text'] as string | undefined, caption: record['caption'] as string | undefined,
      mediaId: record['mediaId']?.toString(),
      location: record['type'] === 'location' ? record['location'] as MessageView['location'] : undefined,
      contacts: record['type'] === 'contacts' ? record['contacts'] as MessageView['contacts'] : undefined,
      poll: record['type'] === 'poll' ? record['poll'] as MessageView['poll'] : undefined,
      pollVote: record['type'] === 'poll_vote' ? record['pollVote'] as MessageView['pollVote'] : undefined,
      interactive: record['type'] === 'interactive' ? record['interactive'] as MessageView['interactive'] : undefined,
      template: record['type'] === 'template' ? record['template'] as MessageView['template'] : undefined,
      reaction: record['type'] === 'reaction' ? record['reaction'] as MessageView['reaction'] : undefined,
      quotedWaMessageId: record['quotedWaMessageId'] as string | undefined, mentions: record['mentions'] as string[] | undefined,
      forwarded: record['forwarded'] as boolean | undefined, editedAt: (record['editedAt'] as Date | undefined)?.toISOString(),
      revokedAt: (record['revokedAt'] as Date | undefined)?.toISOString(), status: record['status'] as MessageView['status'] };
    await this.deps.publish({ type: 'message.updated', tenantId: tenantId.toString(), accountId: accountId.toString(),
      conversationId: conversation._id.toString(), assignedUserId: conversation['assignedUserId']?.toString() ?? null, message });
    const refreshedConversation = await db.collection('conversations').findOne({ _id: conversation._id, tenantId, accountId });
    const contact = await db.collection('contacts').findOne({ _id: contactId, tenantId });
    if (refreshedConversation && contact) await this.deps.publish({ type: 'conversation.updated', tenantId: tenantId.toString(),
      accountId: accountId.toString(), conversation: { _id: refreshedConversation._id.toString(), tenantId: tenantId.toString(),
        accountId: accountId.toString(), contactId: contactId.toString(),
        contactName: contactDisplayName({ displayName: contact['displayName'], pushName: contact['pushName'],
          phoneE164: contact['phoneE164'], waId: contact['waId'] as string, isGroup: Boolean(contact['isGroup']) }),
        contactWaId: contact['waId'] as string, status: refreshedConversation['status'] as 'open' | 'archived',
        assignedUserId: refreshedConversation['assignedUserId']?.toString() ?? null,
        lastMessageAt: (refreshedConversation['lastMessageAt'] as Date).toISOString(),
        lastMessagePreview: refreshedConversation['lastMessagePreview'] as string,
        lastMessageType: refreshedConversation['lastMessageType'] as MessageView['type'],
        lastMessageDirection: refreshedConversation['lastMessageDirection'] as 'in' | 'out',
        unreadCount: refreshedConversation['unreadCount'] as number } });
  }
}
