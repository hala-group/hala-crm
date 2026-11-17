import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, connection, disconnect, Types } from 'mongoose';
import sharp from 'sharp';
import { type StorageRegistry } from '@hala/shared/storage';
import { type SessionManager } from '../session/session.manager.js';
import { AvatarProcessor } from './avatar.processor.js';

describe('profile pictures', () => {
  let mongo: MongoMemoryServer;
  const tenantId = new Types.ObjectId();
  const accountId = new Types.ObjectId();
  const contactId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const stored = new Map<string, Buffer>();
  const picture = vi.fn<(...args: unknown[]) => Promise<Buffer | null>>();
  const details = vi.fn<(...args: unknown[]) => Promise<{ about: string | null; commonGroups: { id: string; name: string }[] } | null>>();
  let processor: AvatarProcessor;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await connect(mongo.getUri());
    const db = connection.db!;
    await db.collection('whatsapp_accounts').insertOne({ _id: accountId, tenantId, provider: 'baileys' });
    await db.collection('contacts').insertOne({ _id: contactId, tenantId, waId: '201001234567@s.whatsapp.net' });
    await db.collection('conversations').insertOne({ _id: conversationId, tenantId, accountId, contactId });
    const storage = { defaultDriver: 'local', put: async (key: string, data: Buffer) => { stored.set(key, data); },
      delete: async (key: string) => { stored.delete(key); },
      forDriver: () => storage } as unknown as StorageRegistry;
    const manager = { fetchProfilePicture: picture, fetchContactDetails: details } as unknown as SessionManager;
    processor = new AvatarProcessor(connection, storage, manager);
  });
  afterAll(async () => { await disconnect(); await mongo?.stop(); });

  it('stores an authorized contact picture and records its storage key', async () => {
    picture.mockResolvedValueOnce(await sharp({ create: { width: 30, height: 30, channels: 3,
      background: '#ff0000' } }).jpeg().toBuffer());
    await processor.process({ type: 'refresh_avatar', tenantId: tenantId.toString(),
      accountId: accountId.toString(), contactId: contactId.toString() });
    expect(picture).toHaveBeenCalledWith(accountId.toString(), tenantId.toString(), '201001234567@s.whatsapp.net');
    const record = await connection.db!.collection('contact_avatars').findOne({ tenantId, accountId, contactId });
    expect(record?.['status']).toBe('ready');
    expect(record?.['storageKey']).toMatch(/^[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{24}\/original$/);
    expect(stored.has(record?.['storageKey'] as string)).toBe(true);
    expect((await sharp(stored.get(record?.['storageKey'] as string)).metadata()).format).toBe('jpeg');
  });

  it('keeps a private or absent picture unavailable and removes the old copy', async () => {
    picture.mockResolvedValueOnce(null);
    await processor.process({ type: 'refresh_avatar', tenantId: tenantId.toString(),
      accountId: accountId.toString(), contactId: contactId.toString() });
    const record = await connection.db!.collection('contact_avatars').findOne({ tenantId, accountId, contactId });
    expect(record?.['status']).toBe('unavailable');
    expect(record?.['storageKey']).toBeUndefined();
    expect(stored.size).toBe(0);
  });

  it('stores WhatsApp about and shared groups for the scoped conversation', async () => {
    details.mockResolvedValueOnce({ about: 'Available', commonGroups: [{ id: '12345@g.us', name: 'Friends' }] });
    await processor.processProfile({ type: 'refresh_profile', tenantId: tenantId.toString(),
      accountId: accountId.toString(), contactId: contactId.toString() });
    const record = await connection.db!.collection('conversations').findOne({ _id: conversationId });
    expect(record?.['profileStatus']).toBe('ready');
    expect(record?.['contactAbout']).toBe('Available');
    expect(record?.['commonGroups']).toEqual([{ id: '12345@g.us', name: 'Friends' }]);
  });

  it('updates group displayName when refreshing a group profile with a subject', async () => {
    const groupContactId = new Types.ObjectId();
    const groupConvId = new Types.ObjectId();
    await connection.db!.collection('contacts').insertOne({
      _id: groupContactId,
      tenantId,
      waId: '987654321-1234@g.us',
      isGroup: true
    });
    await connection.db!.collection('conversations').insertOne({
      _id: groupConvId,
      tenantId,
      accountId,
      contactId: groupContactId,
      status: 'open',
      lastMessageAt: new Date(),
      lastMessagePreview: '',
      lastMessageType: 'text',
      lastMessageDirection: 'in',
      unreadCount: 0
    });
    details.mockResolvedValueOnce({ about: 'Group Description', commonGroups: [], subject: 'مجموعة المبيعات' });
    await processor.processProfile({
      type: 'refresh_profile',
      tenantId: tenantId.toString(),
      accountId: accountId.toString(),
      contactId: groupContactId.toString()
    });
    const updated = await connection.db!.collection('contacts').findOne({ _id: groupContactId });
    expect(updated?.['displayName']).toBe('مجموعة المبيعات');
  });
});
