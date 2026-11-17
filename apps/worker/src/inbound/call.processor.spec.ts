import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, connection, disconnect, Types } from 'mongoose';
import { type DomainEvent, type ProviderCallEvent } from '@hala/shared';
import { CallProcessor } from './call.processor.js';

describe('CallProcessor', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 30_000 } }); await connect(mongo.getUri());
    await connection.collection('contacts').createIndex({ tenantId: 1, waId: 1 }, { unique: true });
    await connection.collection('calls').createIndex({ tenantId: 1, accountId: 1, waCallId: 1 }, { unique: true });
  }, 120_000);
  afterAll(async () => { await disconnect(); await mongo?.stop(); });

  it('upserts a call and emits incoming/missed only on state changes', async () => {
    const events: DomainEvent[] = [];
    const processor = new CallProcessor(connection, async event => { events.push(event); });
    const input: ProviderCallEvent = { type: 'wa.call', tenantId: new Types.ObjectId().toString(),
      accountId: new Types.ObjectId().toString(), waCallId: 'call-1', waId: '201000000000@s.whatsapp.net',
      direction: 'in', isVideo: true, status: 'ringing', startedAt: new Date().toISOString() };
    await processor.process(input);
    await processor.process(input);
    await processor.process({ ...input, status: 'missed' });
    expect(events.map(event => event.type)).toEqual(['call.incoming', 'call.missed']);
    expect(await connection.collection('calls').countDocuments({ waCallId: 'call-1' })).toBe(1);
    expect(await connection.collection('conversations').countDocuments({
      tenantId: new Types.ObjectId(input.tenantId), accountId: new Types.ObjectId(input.accountId)
    })).toBe(1);
    const conversation = await connection.collection('conversations').findOne({
      tenantId: new Types.ObjectId(input.tenantId), accountId: new Types.ObjectId(input.accountId)
    });
    expect(conversation).toMatchObject({ lastMessageType: 'system', lastCallAt: new Date(input.startedAt) });
  });

  it('attaches calls to the existing conversation through LID and device JID identities', async () => {
    const processor = new CallProcessor(connection, async () => {});
    const tenantId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const cases = [
      { waId: '249963572923@s.whatsapp.net', lid: '38981324513309@lid', callJid: '38981324513309@lid' },
      { waId: '192243038216273@lid', lid: '192243038216273@lid', callJid: '192243038216273:8@lid' }
    ];
    for (const [index, item] of cases.entries()) {
      const contactId = new Types.ObjectId();
      const conversationId = new Types.ObjectId();
      await connection.collection('contacts').insertOne({ _id: contactId, tenantId, waId: item.waId, lid: item.lid });
      await connection.collection('conversations').insertOne({ _id: conversationId, tenantId, accountId, contactId,
        status: 'open', unreadCount: 0, lastMessageAt: new Date(), lastMessageType: 'text' });
      if (index === 0) await connection.collection('contacts').insertOne({ tenantId, waId: item.lid });
      await processor.process({ type: 'wa.call', tenantId: tenantId.toString(), accountId: accountId.toString(),
        waCallId: `mapped-call-${index}`, waId: item.callJid, direction: 'in', isVideo: false,
        status: 'missed', startedAt: new Date().toISOString() });
      expect(await connection.collection('calls').findOne({ tenantId, accountId, waCallId: `mapped-call-${index}` }))
        .toMatchObject({ contactId });
      expect(await connection.collection('conversations').countDocuments({ tenantId, accountId, contactId }))
        .toBe(1);
    }
    expect(await connection.collection('conversations').countDocuments({ tenantId, accountId })).toBe(2);
  });
});
