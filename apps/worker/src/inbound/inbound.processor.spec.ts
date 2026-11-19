import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, connection, disconnect, Types } from 'mongoose';
import { type DomainEvent, type MessageType, type NormalizedInboundMessage } from '@hala/shared';
import { InboundProcessor } from './inbound.processor.js';
import { MongoSessionRepository } from '../session/mongo-session.repository.js';

describe('inbound persistence', () => {
  let mongo: MongoMemoryServer;
  let processor: InboundProcessor;
  const tenantId = new Types.ObjectId();
  const accountId = new Types.ObjectId();
  const events: DomainEvent[] = [];
  const stored = new Map<string, Buffer>();
  const providerDeletes: Array<{ driver: string; key: string }> = [];
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await connect(mongo.getUri());
    await connection.db!.collection('whatsapp_accounts').insertOne({ _id: accountId, tenantId, label: 'Test' });
    const localStorage = { put: async (key: string, data: Buffer) => { stored.set(key, data); },
      open: async () => { throw new Error('unused'); }, delete: async (key: string) => { stored.delete(key); } };
    processor = new InboundProcessor({ connection, storage: localStorage,
      storageForDriver: driver => driver === 'hostinger' ? { put: localStorage.put, open: localStorage.open,
        delete: async key => { providerDeletes.push({ driver, key }); stored.delete(key); } } : localStorage,
      download: async () => Buffer.from('media'), publish: async event => { events.push(event); } });
    await processor.ensureIndexes();
  }, 60_000);
  afterAll(async () => { await disconnect(); await mongo?.stop(); });

  it('persists all normalized types once with a central contact and no duplicate unread count', async () => {
    const types: MessageType[] = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',
      'contacts', 'reaction', 'poll', 'poll_vote', 'template', 'interactive', 'system', 'unknown'];
    for (let i = 0; i < types.length; i++) {
      const input: NormalizedInboundMessage = {
        tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: `wa-${i}`,
        waId: '201001234567@s.whatsapp.net', phoneE164: '+201001234567', pushName: 'Ali', isGroup: false,
        direction: 'in', type: types[i]!, timestamp: new Date(1_700_000_000_000 + i * 1000),
        ...(types[i] === 'text' ? { text: 'Hello' } : {})
      };
      await processor.process(input);
      await processor.process(input);
    }
    const db = connection.db!;
    expect(await db.collection('contacts').countDocuments({ tenantId })).toBe(1);
    expect(await db.collection('conversations').countDocuments({ tenantId, accountId })).toBe(1);
    expect(await db.collection('messages').countDocuments({ tenantId, accountId })).toBe(types.length);
    expect((await db.collection('conversations').findOne({ tenantId, accountId }))?.['unreadCount']).toBe(types.length - 2);
    expect(events.filter(event => event.type === 'message.created')).toHaveLength(types.length - 2);
    expect(events.filter(event => event.type === 'message.updated' && event.message.type === 'reaction')).toHaveLength(1);
  }, 20_000);

  it('keeps technical events without replacing a real message or notifying users', async () => {
    const db = connection.db!;
    const base: NormalizedInboundMessage = {
      tenantId: tenantId.toString(), accountId: accountId.toString(),
      waId: '201009999999@s.whatsapp.net', isGroup: false, direction: 'in',
      type: 'system', waMessageId: 'technical-first',
      timestamp: new Date('2026-01-02T00:00:00Z'), raw: { stubType: 201 }
    };
    const beforeEvents = events.length;
    await processor.process(base);
    const contact = await db.collection('contacts').findOne({ tenantId, waId: base.waId });
    const scope = { tenantId, accountId, contactId: contact?._id };
    expect((await db.collection('conversations').findOne(scope))?.['lastMessageType']).toBe('system');
    expect(events).toHaveLength(beforeEvents);

    await processor.process({ ...base, waMessageId: 'real-older', type: 'text', text: 'Actual message',
      timestamp: new Date('2026-01-01T00:00:00Z'), raw: undefined });
    await processor.process({ ...base, waMessageId: 'technical-later',
      timestamp: new Date('2026-01-03T00:00:00Z') });
    const conversation = await db.collection('conversations').findOne(scope);
    expect(conversation).toMatchObject({ lastMessageType: 'text', lastMessagePreview: 'Actual message', unreadCount: 1 });
    expect(await db.collection('messages').countDocuments({ ...scope, type: 'system' })).toBe(2);
    expect(events.filter(event => event.type === 'message.created' && event.message.conversationId === conversation?._id.toString())).toHaveLength(1);
  });

  it('persists the group sender and publishes their identity without replacing the group name', async () => {
    const db = connection.db!;
    const groupId = new Types.ObjectId();
    await db.collection('contacts').insertOne({ _id: groupId, tenantId, waId: '8888@g.us', isGroup: true, displayName: 'المبيعات' });
    await processor.process({ tenantId: tenantId.toString(), accountId: accountId.toString(),
      waId: '8888@g.us', waMessageId: 'group-with-sender', isGroup: true, pushName: 'اسم العضو', direction: 'in',
      type: 'text', text: 'تفاصيل الطلب', timestamp: new Date(),
      sender: { waId: '201008888888@s.whatsapp.net', name: 'اسم العضو', phoneE164: '+201008888888' } });
    const member = await db.collection('contacts').findOne({ tenantId, waId: '201008888888@s.whatsapp.net' });
    const message = await db.collection('messages').findOne({ tenantId, accountId, waMessageId: 'group-with-sender' });
    expect(message?.['senderContactId']).toEqual(member?._id);
    expect(message?.['sender']).toMatchObject({ name: 'اسم العضو', contactId: member?._id.toString() });
    expect((await db.collection('contacts').findOne({ _id: groupId }))?.['displayName']).toBe('المبيعات');
    expect(events.find(event => event.type === 'message.created' && event.message.waMessageId === 'group-with-sender'))
      .toMatchObject({ message: { sender: { name: 'اسم العضو', contactId: member?._id.toString() }, text: 'تفاصيل الطلب' } });
  });

  it('ignores stale outgoing sender names and aliases without merging the recipient into self', async () => {
    const db = connection.db!;
    const ownContactId = new Types.ObjectId(), recipientId = new Types.ObjectId();
    const lid = '999999111111@lid', jid = '201001111111@s.whatsapp.net';
    await db.collection('contacts').insertMany([
      { _id: ownContactId, tenantId, waId: '201009999998@s.whatsapp.net', lid, isSelf: true, displayName: 'اسم المالك' },
      { _id: recipientId, tenantId, waId: jid, pushName: 'اسم العميل الصحيح', isGroup: false }
    ]);
    await processor.process({ tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'stale-out-name',
      waId: jid, lid, pushName: 'اسم المالك', direction: 'out', isGroup: false, type: 'text', text: 'Reply', timestamp: new Date() });
    expect(await db.collection('messages').findOne({ tenantId, accountId, waMessageId: 'stale-out-name' })).toMatchObject({ contactId: recipientId });
    const recipient = await db.collection('contacts').findOne({ tenantId, _id: recipientId });
    expect(recipient?.['pushName']).toBe('اسم العميل الصحيح');
    expect(recipient?.['lid']).toBeUndefined();
    expect(events.find(event => event.type === 'conversation.updated' && event.conversation.contactId === recipientId.toString()))
      .toMatchObject({ conversation: { contactName: 'اسم العميل الصحيح' } });
    expect((await db.collection('contacts').findOne({ tenantId, _id: ownContactId }))?.['displayName']).toBe('اسم المالك');
  });

  it('scopes self presentation to each account and keeps saved contact names intact', async () => {
    const db = connection.db!;
    const selfAccount = new Types.ObjectId();
    await db.collection('whatsapp_accounts').insertOne({ _id: selfAccount, tenantId, phoneNumber: '201002222223',
      ownJid: '201002222223@s.whatsapp.net', ownLid: '222222222223@lid' });
    const input: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: selfAccount.toString(),
      waId: '201002222223@s.whatsapp.net', waMessageId: 'own-scoped-1', isSelf: true, isGroup: false,
      direction: 'out', pushName: 'أنت', type: 'text', timestamp: new Date() };
    await processor.syncContact({ tenantId: input.tenantId, accountId: input.accountId,
      contact: { id: input.waId, name: 'اسم محفوظ للحساب' } });
    await processor.process(input);
    await processor.process({ ...input, accountId: accountId.toString(), waMessageId: 'other-scoped-1', isSelf: false, direction: 'in', pushName: undefined });
    const contact = await db.collection('contacts').findOne({ tenantId, waId: input.waId });
    expect(contact?.['displayName']).toBe('اسم محفوظ للحساب');
    const ownEvents = events.filter(event => event.type === 'conversation.updated' && event.conversation.contactId === contact?._id.toString());
    expect(ownEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: selfAccount.toString(), conversation: expect.objectContaining({ contactName: 'أنت (رسائل شخصية)' }) }),
      expect.objectContaining({ accountId: accountId.toString(), conversation: expect.objectContaining({ contactName: 'اسم محفوظ للحساب' }) })
    ]));
  });

  it('does not keep a previous account owner LID after a new identity connects', async () => {
    const db = connection.db!, relinkedId = new Types.ObjectId();
    await db.collection('whatsapp_accounts').insertOne({ _id: relinkedId, tenantId,
      ownJid: '201003333330@s.whatsapp.net', ownLid: '333333333330@lid' });
    const repository = new MongoSessionRepository(connection);
    await repository.update({ type: 'wa.connection', tenantId: tenantId.toString(), accountId: relinkedId.toString(),
      status: 'connected', phoneNumber: '201003333331@s.whatsapp.net', ownJid: '201003333331@s.whatsapp.net' }, 'test-worker');
    const account = await db.collection('whatsapp_accounts').findOne({ _id: relinkedId, tenantId });
    expect(account?.['ownLid']).toBeUndefined();
    expect(account?.['ownJid']).toBe('201003333331@s.whatsapp.net');
    await processor.process({ tenantId: tenantId.toString(), accountId: relinkedId.toString(),
      waId: '333333333330@lid', lid: '333333333330@lid', isSelf: true, waMessageId: 'old-owner',
      isGroup: false, direction: 'in', type: 'text', timestamp: new Date() });
    const event = events.find(item => item.type === 'conversation.updated' && item.accountId === relinkedId.toString());
    expect(event).toMatchObject({ conversation: { contactName: 'رقم غير متاح · معرّف 3330' } });
  });

  it('stores media bytes outside MongoDB and remains idempotent', async () => {
    const input: NormalizedInboundMessage = {
      tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'media-doc',
      waId: '201001234567@s.whatsapp.net', isGroup: false, direction: 'in', type: 'document',
      timestamp: new Date(), mediaSource: { kind: 'document', mimeType: 'application/pdf', mediaKeyBase64: 'YQ==', url: 'https://example.test/media' }
    };
    await processor.process(input);
    await processor.process(input);
    const asset = await connection.db!.collection('media').findOne({ tenantId, accountId });
    expect(asset?.['status']).toBe('ready');
    expect(asset?.['sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.get(asset?.['storageKey'] as string)?.toString()).toBe('media');
    expect(await connection.db!.collection('media').countDocuments({ tenantId, accountId })).toBe(1);
  });

  it('keeps missing text explicit and hides a raw LID from conversation events', async () => {
    const input: NormalizedInboundMessage = {
      tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'missing-text',
      waId: 'lid@71722363576571', isGroup: false, direction: 'in', type: 'text', timestamp: new Date()
    };
    await processor.process(input);
    const contact = await connection.db!.collection('contacts').findOne({ tenantId, waId: input.waId });
    const conversation = await connection.db!.collection('conversations').findOne({ tenantId, accountId, contactId: contact?._id });
    expect(conversation?.['lastMessagePreview']).toBe('');
    const event = events.find(item => item.type === 'conversation.updated' && item.conversation.contactId === contact?._id.toString());
    expect(event?.type === 'conversation.updated' ? event.conversation.contactName : null).toBe('رقم غير متاح · معرّف 6571');
  });

  it('fills historical LID contacts from WhatsApp metadata and preserves their names', async () => {
    const lid = '38981324513309@lid';
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'named-lid-1', waId: lid, lid, isGroup: false, direction: 'in', type: 'text',
      text: 'Hello', timestamp: new Date() };
    await processor.process(base);
    await processor.syncContact({ tenantId: tenantId.toString(), accountId: accountId.toString(),
      contact: { id: lid, lid, jid: '201001234568@s.whatsapp.net', name: 'اسم محفوظ', notify: 'اسم واتساب' } });
    await processor.process({ ...base, waMessageId: 'named-lid-2', pushName: undefined });
    await processor.process({ ...base, waMessageId: 'named-phone', waId: '201001234568@s.whatsapp.net',
      phoneE164: '+201001234568', lid });
    const db = connection.db!;
    const contacts = await db.collection('contacts').find({ tenantId, lid }).toArray();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.['displayName']).toBe('اسم محفوظ');
    expect(contacts[0]?.['pushName']).toBe('اسم واتساب');
    expect(contacts[0]?.['phoneE164']).toBe('+201001234568');
    expect(await db.collection('conversations').countDocuments({ tenantId, accountId, contactId: contacts[0]?._id })).toBe(1);
    expect(events.some(event => event.type === 'conversation.updated' && event.conversation.contactName === 'اسم محفوظ')).toBe(true);
  });

  it('links a known phone contact to its LID when WhatsApp later shares the mapping', async () => {
    const db = connection.db!;
    const jid = '201001234569@s.whatsapp.net';
    const lid = '38981324513310@lid';
    await db.collection('contacts').insertOne({ tenantId, waId: jid, phoneE164: '+201001234569', isGroup: false });
    await processor.syncContact({ tenantId: tenantId.toString(), accountId: accountId.toString(), contact: { id: lid, lid, jid } });
    expect(await db.collection('contacts').findOne({ tenantId, waId: jid })).toMatchObject({ lid, phoneE164: '+201001234569' });
    await processor.process({ tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'known-lid-1',
      waId: lid, lid, isGroup: false, direction: 'in', type: 'text', text: 'Hello', timestamp: new Date() });
    expect(await db.collection('contacts').countDocuments({ tenantId, waId: lid })).toBe(0);
  });

  it('syncs a WhatsApp group contact with its subject and marks it as isGroup', async () => {
    const db = connection.db!;
    const groupId = '123456789-3813@g.us';
    await processor.syncContact({
      tenantId: tenantId.toString(),
      accountId: accountId.toString(),
      contact: { id: groupId, name: 'فريق عمل المبيعات' }
    });
    const contact = await db.collection('contacts').findOne({ tenantId, waId: groupId });
    expect(contact).toMatchObject({ displayName: 'فريق عمل المبيعات', isGroup: true });
  });

  it('ignores status feeds before creating contacts, conversations, messages or events', async () => {
    const input: NormalizedInboundMessage = {
      tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'status-feed-1',
      waId: 'status@broadcast', isGroup: false, direction: 'in', type: 'image', timestamp: new Date()
    };
    const db = connection.db!;
    const before = {
      contacts: await db.collection('contacts').countDocuments({ tenantId }),
      conversations: await db.collection('conversations').countDocuments({ tenantId, accountId }),
      messages: await db.collection('messages').countDocuments({ tenantId, accountId }), events: events.length
    };
    await processor.process(input);
    expect(await db.collection('contacts').countDocuments({ tenantId })).toBe(before.contacts);
    expect(await db.collection('conversations').countDocuments({ tenantId, accountId })).toBe(before.conversations);
    expect(await db.collection('messages').countDocuments({ tenantId, accountId })).toBe(before.messages);
    expect(events).toHaveLength(before.events);
  });

  it('imports history without unread alerts and repairs a previously empty message', async () => {
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'history-repair', waId: '201001234567@s.whatsapp.net', isGroup: false,
      direction: 'in', type: 'text', timestamp: new Date('2026-01-01T00:00:00Z') };
    await processor.process(base);
    const db = connection.db!;
    const contact = await db.collection('contacts').findOne({ tenantId, waId: base.waId });
    const scope = { tenantId, accountId, contactId: contact?._id };
    const unread = (await db.collection('conversations').findOne(scope))?.['unreadCount'];
    const alerts = events.filter(event => event.type === 'message.created').length;
    await processor.process({ ...base, text: 'Recovered', history: true });
    await processor.process({ ...base, waMessageId: 'history-older', text: 'Older', history: true });
    expect((await db.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId }))?.['text']).toBe('Recovered');
    expect((await db.collection('conversations').findOne(scope))?.['unreadCount']).toBe(unread);
    expect(events.filter(event => event.type === 'message.created')).toHaveLength(alerts);
  });

  it('imports a chat snapshot once and keeps archived chats archived when older messages arrive', async () => {
    const db = connection.db!;
    const waId = '201001112229@s.whatsapp.net';
    const scope = { tenantId: tenantId.toString(), accountId: accountId.toString() };
    const historyChat = { timestamp: new Date('2026-02-01T00:00:00Z'), unreadCount: 2 };
    const snapshot = { ...scope, contact: { id: waId, name: 'History contact' }, historyChat };
    await processor.syncContact(snapshot);
    const contact = await db.collection('contacts').findOne({ tenantId, waId });
    const conversations = db.collection('conversations');
    const filter = { tenantId, accountId, contactId: contact?._id };
    expect(await conversations.countDocuments(filter)).toBe(1);
    await conversations.updateOne(filter, { $set: { status: 'archived', unreadCount: 0 } });
    await processor.syncContact(snapshot);
    await processor.process({ ...scope, waId, waMessageId: 'history-archived', isGroup: false, direction: 'in',
      text: 'Restored message', type: 'text', history: true, timestamp: new Date('2026-01-01T00:00:00Z') });
    expect(await conversations.findOne(filter)).toMatchObject({
      status: 'archived', unreadCount: 0, lastMessagePreview: 'Restored message'
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'message.updated',
      message: expect.objectContaining({ waMessageId: 'history-archived' }) }));
  });

  it('saves history messages while an older attachment is still downloading', async () => {
    const db = connection.db!;
    const enqueueHistoryMedia = vi.fn(async (_message: NormalizedInboundMessage) => {});
    let finishDownload!: (bytes: Buffer) => void;
    const waitingForMedia = new Promise<Buffer>(resolve => { finishDownload = resolve; });
    const download = vi.fn(() => waitingForMedia);
    const publish = vi.fn(async (_event: DomainEvent) => {});
    const storage = { put: vi.fn(async () => {}), open: async () => { throw new Error('unused'); },
      delete: vi.fn(async () => {}) };
    const importer = new InboundProcessor({ connection, storage, download, enqueueHistoryMedia, publish });
    const base = { tenantId: tenantId.toString(), accountId: accountId.toString(), waId: '201000009999@s.whatsapp.net',
      timestamp: new Date('2026-01-01T00:00:00Z'), isGroup: false, direction: 'in' as const, history: true };
    const attachment: NormalizedInboundMessage = { ...base, waMessageId: 'queued-history-media', type: 'document',
      mediaSource: { kind: 'document', mimeType: 'application/pdf', directPath: '/test-document' } };
    await importer.process(attachment);
    expect(enqueueHistoryMedia).toHaveBeenCalledWith(attachment);
    expect(download).not.toHaveBeenCalled();
    const mediaTask = importer.processHistoryMedia(attachment);
    try {
      await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
      await importer.process({ ...base, waMessageId: 'text-after-media', type: 'text', text: 'Recovered history' });
      expect(await db.collection('messages').findOne({ tenantId, accountId, waMessageId: 'text-after-media' }))
        .toMatchObject({ text: 'Recovered history' });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.updated',
        message: expect.objectContaining({ waMessageId: 'text-after-media' }) }));
      expect(storage.put).not.toHaveBeenCalled();
    } finally {
      finishDownload(Buffer.from('document'));
      await mediaTask;
    }
    await importer.processHistoryMedia(attachment);
    expect(download).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.media_ready' }));
  });

  it('syncs read and marked-unread state from another WhatsApp device', async () => {
    const chatId = '201008888888@s.whatsapp.net';
    const tenant = tenantId.toString();
    const account = accountId.toString();
    await processor.process({ tenantId: tenant, accountId: account, waMessageId: 'phone-read-state', waId: chatId,
      phoneE164: '+201008888888', isGroup: false, direction: 'in', type: 'text', text: 'Phone read state', timestamp: new Date() });
    const contact = await connection.db!.collection('contacts').findOne({ tenantId, waId: chatId });
    const scope = { tenantId, accountId, contactId: contact?._id };
    const conversation = await connection.db!.collection('conversations').findOne(scope);
    expect(conversation?.['unreadCount']).toBe(1);

    const beforeRead = events.length;
    await processor.syncChatReadState({ tenantId: tenant, accountId: account, chatId, isUnread: false });
    expect((await connection.db!.collection('conversations').findOne(scope))?.['unreadCount']).toBe(0);
    expect(events.slice(beforeRead).at(-1)).toMatchObject({ type: 'conversation.updated',
      conversation: { _id: conversation?._id.toString(), unreadCount: 0 } });

    const beforeMarkUnread = events.length;
    await processor.syncChatReadState({ tenantId: tenant, accountId: account, chatId, isUnread: true });
    expect((await connection.db!.collection('conversations').findOne(scope))?.['unreadCount']).toBe(1);
    expect(events.slice(beforeMarkUnread).at(-1)).toMatchObject({ type: 'conversation.updated',
      conversation: { _id: conversation?._id.toString(), unreadCount: 1 } });

    const beforeDuplicate = events.length;
    await processor.syncChatReadState({ tenantId: tenant, accountId: account, chatId, isUnread: true });
    expect(events).toHaveLength(beforeDuplicate);
  });

  it('clears unread count when the latest inbound message is read on the phone', async () => {
    const chatId = '38981324519999@lid';
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waId: chatId, isGroup: false, direction: 'in', type: 'text', text: 'Phone read',
      waMessageId: 'phone-read-older', timestamp: new Date('2026-11-14T15:00:00Z') };
    await processor.process(base);
    await processor.process({ ...base, waMessageId: 'phone-read-latest', timestamp: new Date('2026-11-14T15:01:00Z') });
    const contact = await connection.db!.collection('contacts').findOne({ tenantId, waId: chatId });
    const scope = { tenantId, accountId, contactId: contact?._id };
    expect((await connection.db!.collection('conversations').findOne(scope))?.['unreadCount']).toBe(2);

    await connection.db!.collection('messages').updateOne({ tenantId, accountId, waMessageId: 'phone-read-older' },
      { $set: { status: 'read' } });
    await processor.syncMessageReadState({ tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'phone-read-older' });
    expect((await connection.db!.collection('conversations').findOne(scope))?.['unreadCount']).toBe(2);

    await connection.db!.collection('messages').updateOne({ tenantId, accountId, waMessageId: 'phone-read-latest' },
      { $set: { status: 'read' } });
    await processor.syncMessageReadState({ tenantId: tenantId.toString(), accountId: accountId.toString(), waMessageId: 'phone-read-latest' });
    expect((await connection.db!.collection('conversations').findOne(scope))?.['unreadCount']).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'conversation.updated', conversation: { unreadCount: 0 } });
  });

  it('repairs a historical media message previously misclassified as empty text', async () => {
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'history-document-repair', waId: '201001234567@s.whatsapp.net', isGroup: false,
      direction: 'in', type: 'text', timestamp: new Date('2026-01-02T00:00:00Z') };
    await processor.process(base);
    await processor.process({ ...base, type: 'document', history: true,
      raw: { messageType: 'documentMessage' },
      mediaSource: { kind: 'document', mimeType: 'application/pdf', mediaKeyBase64: 'YQ==', url: 'https://example.test/media' } });
    const message = await connection.db!.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId });
    expect(message?.['type']).toBe('document');
    expect(message?.['mediaId']).toBeTruthy();
    expect(await connection.db!.collection('media').countDocuments({ tenantId, accountId, messageId: message?._id })).toBe(1);
  });

  it('stores interactive, template and poll vote details for rendering', async () => {
    const input: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'typed-content', waId: '201007777777@s.whatsapp.net', isGroup: false, direction: 'in',
      type: 'interactive', text: 'Yes', interactive: { kind: 'button_reply', selectedId: 'yes', selectedTitle: 'Yes' },
      pollVote: { targetWaMessageId: 'poll-1', selectedOptions: ['Blue'] },
      template: { name: 'welcome', language: 'ar', body: 'Welcome', componentsJson: '[]' }, timestamp: new Date() };
    await processor.process(input);
    const message = await connection.db!.collection('messages').findOne({ tenantId, accountId, waMessageId: input.waMessageId });
    expect(message).toMatchObject({ interactive: { kind: 'button_reply', selectedId: 'yes', selectedTitle: 'Yes' },
      pollVote: { targetWaMessageId: 'poll-1', selectedOptions: ['Blue'] },
      template: { name: 'welcome', language: 'ar', body: 'Welcome', componentsJson: '[]' } });
    expect(events.find(event => event.type === 'message.created' && event.message.waMessageId === input.waMessageId))
      .toMatchObject({ message: { interactive: { selectedTitle: 'Yes' }, pollVote: { selectedOptions: ['Blue'] } } });
  });

  it('applies inbound edits and revocations to their original message without creating system messages', async () => {
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'mutation-target', waId: '201006666666@s.whatsapp.net', isGroup: false, direction: 'in',
      type: 'text', text: 'Before edit', timestamp: new Date('2026-04-01T00:00:00Z') };
    await processor.process(base);
    const mutationEvent: NormalizedInboundMessage = { ...base, waMessageId: 'mutation-edit-event', type: 'system', text: undefined,
      mutation: { kind: 'edit', targetWaMessageId: base.waMessageId, text: 'After edit' }, timestamp: new Date('2026-04-01T00:01:00Z') };
    await processor.process(mutationEvent);
    const db = connection.db!;
    let original = await db.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId });
    expect(original).toMatchObject({ type: 'text', text: 'After edit', editedAt: mutationEvent.timestamp });
    expect(await db.collection('messages').findOne({ tenantId, accountId, waMessageId: mutationEvent.waMessageId })).toBeNull();

    await processor.process({ ...mutationEvent, waMessageId: 'mutation-revoke-event', mutation: {
      kind: 'revoke', targetWaMessageId: base.waMessageId
    }, timestamp: new Date('2026-04-01T00:02:00Z') });
    original = await db.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId });
    expect(original).toMatchObject({ revokedAt: new Date('2026-04-01T00:02:00Z') });
    expect(original?.['text']).toBeUndefined();
  });

  it('deletes revoked media from the provider recorded on the media asset', async () => {
    const db = connection.db!;
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'hostinger-revoke-target', waId: '201004444444@s.whatsapp.net', isGroup: false,
      direction: 'in', type: 'image', timestamp: new Date(), text: 'image' };
    await processor.process(base);
    const message = await db.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId });
    expect(message).not.toBeNull();
    const mediaId = new Types.ObjectId();
    const key = `${tenantId}/${accountId}/${mediaId}/original`;
    await db.collection('media').insertOne({ _id: mediaId, tenantId, accountId, messageId: message!._id,
      storageKey: key, thumbnailKey: `${tenantId}/${accountId}/${mediaId}/thumb`, storageDriver: 'hostinger',
      mimeType: 'image/jpeg', status: 'ready' });
    await db.collection('messages').updateOne({ _id: message!._id, tenantId, accountId }, { $set: { mediaId } });
    const before = providerDeletes.length;
    await processor.process({ ...base, waMessageId: 'hostinger-revoke-event', type: 'system', text: undefined,
      mutation: { kind: 'revoke', targetWaMessageId: base.waMessageId }, timestamp: new Date() });
    expect(providerDeletes.slice(before)).toEqual([
      { driver: 'hostinger', key }, { driver: 'hostinger', key: `${tenantId}/${accountId}/${mediaId}/thumb` }
    ]);
  });

  it('holds a protocol mutation until its original message arrives', async () => {
    const base: NormalizedInboundMessage = { tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: 'late-mutation-target', waId: '201005555555@s.whatsapp.net', isGroup: false, direction: 'in',
      type: 'text', text: 'Original', timestamp: new Date('2026-05-01T00:00:00Z') };
    await processor.process({ ...base, waMessageId: 'late-edit-event', type: 'system', text: undefined,
      mutation: { kind: 'edit', targetWaMessageId: base.waMessageId, text: 'Edited before arrival' } });
    await processor.process(base);
    const message = await connection.db!.collection('messages').findOne({ tenantId, accountId, waMessageId: base.waMessageId });
    expect(message).toMatchObject({ text: 'Edited before arrival', editedAt: expect.any(Date) });
    expect(await connection.db!.collection('pending_message_mutations').countDocuments({ tenantId, accountId })).toBe(0);
  });
});
