import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, connection, disconnect, Types } from 'mongoose';
import { type DomainEvent, type OutgoingMessageInput, type ProviderAccount, type ProviderCapability,
  type ProviderEvent, type ProviderSendRequest, type ProviderSession, type WhatsAppProvider } from '@hala/shared';
import { LeaseService, type Lease, type LeaseBackend } from '../session/lease.service.js';
import { SessionManager, type SessionRepository } from '../session/session.manager.js';
import { OutboundProcessor } from './outbound.processor.js';

class MemoryLeases implements LeaseBackend {
  private currentLease?: Lease;
  async acquire(accountId: string, workerId: string): Promise<Lease | null> {
    if (this.currentLease) return null;
    this.currentLease = { accountId, workerId, fencingToken: 1 }; return this.currentLease;
  }
  async renew(lease: Lease): Promise<boolean> { return this.currentLease?.accountId === lease.accountId; }
  async release(): Promise<boolean> { this.currentLease = undefined; return true; }
  async current(): Promise<Lease | null> { return this.currentLease ?? null; }
}
class FakeProvider implements WhatsAppProvider {
  readonly name = 'fake';
  readonly capabilities = new Set<ProviderCapability>(['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker',
    'location', 'contacts', 'reaction', 'poll', 'reply', 'mentions', 'edit', 'revoke', 'forward']);
  readonly sent: ProviderSendRequest[] = [];
  readonly recipientInbox = new Map<string, ProviderSendRequest[]>();
  readonly edits: string[] = [];
  readonly revokes: string[] = [];
  failNext = false;
  async open(_account: ProviderAccount, _fence: number, _emit: (event: ProviderEvent) => Promise<void>): Promise<ProviderSession> {
    return { close: async () => {} };
  }
  async logout(): Promise<void> {}
  async send(_account: ProviderAccount, request: ProviderSendRequest): Promise<string> {
    this.sent.push(request);
    if (this.failNext) { this.failNext = false; throw new Error('temporary failure'); }
    this.recipientInbox.set(request.jid, [...(this.recipientInbox.get(request.jid) ?? []), request]);
    return request.messageId;
  }
  async edit(_account: ProviderAccount, _jid: string, _key: unknown, text: string): Promise<void> { this.edits.push(text); }
  async revoke(_account: ProviderAccount, _jid: string, key: { id: string }): Promise<void> { this.revokes.push(key.id); }
  async markRead(): Promise<void> {}
}

describe('outbound pipeline with FakeProvider', () => {
  let mongo: MongoMemoryServer;
  let manager: SessionManager;
  let processor: OutboundProcessor;
  const provider = new FakeProvider();
  const tenantId = new Types.ObjectId();
  const accountId = new Types.ObjectId();
  const contactId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const events: DomainEvent[] = [];
  const stored = new Map<string, Buffer>();
  const ids: string[] = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await connect(mongo.getUri());
    const db = connection.db!;
    await db.collection('whatsapp_accounts').insertOne({ _id: accountId, tenantId, provider: 'baileys',
      settings: { sendPacing: { minDelayMs: 0, maxDelayMs: 0 } } });
    await db.collection('contacts').insertOne({ _id: contactId, tenantId, waId: '201001234567@s.whatsapp.net' });
    await db.collection('conversations').insertOne({ _id: conversationId, tenantId, accountId, contactId,
      status: 'open', lastMessageAt: new Date(), lastMessagePreview: '', lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 });
    const repository: SessionRepository = { desiredAccounts: async () => [{ id: accountId.toString(), tenantId: tenantId.toString(),
      provider: 'baileys', desiredState: 'connected' }], get: async () => null, update: async () => {}, clearAuth: async () => {} };
    manager = new SessionManager(new LeaseService(new MemoryLeases(), 'fake-worker', 30_000), repository, provider,
      { publish: async () => {} }, 10);
    await manager.tick();
    processor = new OutboundProcessor({ connection, manager, storage: {
      put: async (key, bytes) => { stored.set(key, bytes); },
      open: async key => { const { Readable } = await import('node:stream'); return { stream: Readable.from([stored.get(key)!]) }; }
    }, publish: async event => { events.push(event); } });
  }, 60_000);
  afterAll(async () => { await manager?.stop(); await disconnect(); await mongo?.stop(); });

  const base = { accountId: accountId.toString(), conversationId: conversationId.toString() };
  async function save(input: OutgoingMessageInput) {
    const id = new Types.ObjectId();
    const waMessageId = input.clientMessageId.replaceAll('-', '').toUpperCase();
    await connection.db!.collection('messages').insertOne({ _id: id, tenantId, accountId, conversationId, contactId,
      waMessageId, clientMessageId: input.clientMessageId, type: input.type, direction: 'out', status: 'pending',
      statusHistory: [], timestamp: new Date(), outbound: input });
    ids.push(id.toString());
    return { id: id.toString(), waMessageId };
  }

  it('sends every Baileys supported type, including media, reply, mentions and reaction', async () => {
    const assetId = new Types.ObjectId();
    const key = `${tenantId}/${accountId}/${assetId}`;
    stored.set(key, Buffer.from('media-bytes'));
    await connection.db!.collection('media').insertOne({ _id: assetId, tenantId, accountId,
      storageKey: key, mimeType: 'application/pdf', status: 'ready' });
    const variants: Array<Omit<OutgoingMessageInput, 'accountId' | 'conversationId' | 'clientMessageId'>> = [
      { type: 'text', text: 'Hello', linkPreview: true },
      { type: 'image', mediaId: assetId.toString() }, { type: 'video', mediaId: assetId.toString() },
      { type: 'audio', mediaId: assetId.toString() }, { type: 'voice', mediaId: assetId.toString() },
      { type: 'document', mediaId: assetId.toString() }, { type: 'sticker', mediaId: assetId.toString() },
      { type: 'location', lat: 30, lng: 31 },
      { type: 'contacts', contacts: [{ name: 'Bob', phones: ['+201001234567'] }] },
      { type: 'poll', question: 'Ready?', options: ['Yes', 'No'], selectableCount: 1 }
    ] as Array<Omit<OutgoingMessageInput, 'accountId' | 'conversationId' | 'clientMessageId'>>;
    for (const variant of variants) {
      const input = { ...base, ...variant, clientMessageId: crypto.randomUUID() } as OutgoingMessageInput;
      const { id } = await save(input);
      await processor.process({ type: 'outbound', operation: 'send', tenantId: tenantId.toString(), accountId: accountId.toString(), messageId: id });
      expect((await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(id) }))?.['status']).toBe('sent');
    }
    expect(provider.sent.map(request => request.input.type)).toEqual(variants.map(variant => variant.type));
    expect(provider.recipientInbox.get('201001234567@s.whatsapp.net')?.map(item => item.input.type))
      .toEqual(variants.map(variant => variant.type));
    const first = ids[0]!;
    const replyInput = { ...base, clientMessageId: crypto.randomUUID(), type: 'text' as const, text: 'Reply',
      linkPreview: true, replyToMessageId: first, mentions: ['201001234567@s.whatsapp.net'] };
    const reply = await save(replyInput);
    await processor.process({ type: 'outbound', operation: 'send', tenantId: tenantId.toString(), accountId: accountId.toString(), messageId: reply.id });
    expect(provider.sent.at(-1)?.quoted?.id).toBe((await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(first) }))?.['waMessageId']);
    const reactionInput = { ...base, clientMessageId: crypto.randomUUID(), type: 'reaction' as const, targetMessageId: first, emoji: '👍' };
    const reaction = await save(reactionInput);
    await processor.process({ type: 'outbound', operation: 'send', tenantId: tenantId.toString(), accountId: accountId.toString(), messageId: reaction.id });
    expect(provider.sent.at(-1)?.target?.id).toBe(reply.waMessageId === '' ? '' : (await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(first) }))?.['waMessageId']);
  });

  it('handles edit, revoke, forward and delivered/read updates', async () => {
    const first = ids[0]!;
    await connection.db!.collection('messages').updateOne({ _id: new Types.ObjectId(first) }, { $set: { pendingEditText: 'Edited' } });
    const command = { type: 'outbound' as const, tenantId: tenantId.toString(), accountId: accountId.toString(), messageId: first };
    await processor.process({ ...command, operation: 'edit' });
    expect(provider.edits).toEqual(['Edited']);
    await processor.process({ ...command, operation: 'revoke' });
    expect(provider.revokes).toHaveLength(1);
    const original = await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(first) });
    await processor.status({ type: 'wa.message.status', tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: original?.['waMessageId'] as string, status: 'delivered' });
    await processor.status({ type: 'wa.message.status', tenantId: tenantId.toString(), accountId: accountId.toString(),
      waMessageId: original?.['waMessageId'] as string, status: 'read' });
    expect((await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(first) }))?.['status']).toBe('read');
    expect(events.some(event => event.type === 'message.status' && event.status === 'read')).toBe(true);
    const forwarded = await save({ ...base, clientMessageId: crypto.randomUUID(), type: 'text', text: 'Forwarded', linkPreview: true });
    await processor.process({ ...command, messageId: forwarded.id, operation: 'forward' });
    expect(provider.sent.at(-1)?.forwarded).toBe(true);
  });

  it('exposes a failure and retries with the same WhatsApp message ID', async () => {
    const input = { ...base, clientMessageId: crypto.randomUUID(), type: 'text' as const, text: 'Retry', linkPreview: true };
    const saved = await save(input);
    const command = { type: 'outbound' as const, tenantId: tenantId.toString(), accountId: accountId.toString(), messageId: saved.id,
      operation: 'send' as const };
    provider.failNext = true;
    await expect(processor.process(command)).rejects.toThrow('temporary failure');
    expect((await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(saved.id) }))?.['status']).toBe('failed');
    await processor.process(command);
    expect((await connection.db!.collection('messages').findOne({ _id: new Types.ObjectId(saved.id) }))?.['status']).toBe('sent');
    expect(provider.sent.slice(-2).map(request => request.messageId)).toEqual([saved.waMessageId, saved.waMessageId]);
  });
});
