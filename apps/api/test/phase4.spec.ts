import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInTenant } from '../src/common/tenant-context.js';
import { bootstrapTenant } from '../src/modules/tenants/bootstrap-tenant.js';
import { type TenantRecord } from '../src/modules/tenants/tenant.schema.js';
import { type RoleRecord } from '../src/modules/roles/role.schema.js';
import { type UserRecord } from '../src/modules/users/user.schema.js';
import { type ContactRecord, type ConversationRecord, type MessageRecord } from '../src/modules/inbox/inbox.schema.js';
import { AccountCommandService } from '../src/modules/whatsapp-accounts/account-command.service.js';

describe('Phase 4 outbound authorization and API', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let ownerToken: string;
  let viewerToken: string;
  let accountId: string;
  let conversationId: string;
  let tenantId: string;
  let messages: Model<MessageRecord>;
  const queue = { send: vi.fn(async () => true) };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.JWT_ACCESS_SECRET = 'phase4-test-access-secret-that-is-long-enough';
    process.env.JWT_REFRESH_SECRET = 'phase4-test-refresh-secret-that-is-long-enough';
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountCommandService).useValue(queue).compile();
    app = module.createNestApplication();
    app.use(cookieParser()); app.setGlobalPrefix('api/v1'); await app.init();
    const tenants = module.get<Model<TenantRecord>>(getModelToken('Tenant'));
    const roles = module.get<Model<RoleRecord>>(getModelToken('Role'));
    const users = module.get<Model<UserRecord>>(getModelToken('User'));
    const contacts = module.get<Model<ContactRecord>>(getModelToken('Contact'));
    const conversations = module.get<Model<ConversationRecord>>(getModelToken('Conversation'));
    messages = module.get<Model<MessageRecord>>(getModelToken('Message'));
    tenantId = await bootstrapTenant({ tenants, roles, users }, { slug: 'send-test', name: 'Send Test',
      ownerEmail: 'owner@send.test', ownerPassword: 'test-password-123' });
    const owner = await runInTenant(tenantId, async () => users.findOne({ email: 'owner@send.test' }).select('+passwordHash'));
    if (!owner) throw new Error('Owner missing');
    const viewerRole = await runInTenant(tenantId, () => roles.create({ tenantId, name: 'Viewer',
      permissions: ['accounts:read', 'conversations:read_all'], isSystem: false }));
    const viewer = await runInTenant(tenantId, () => users.create({ tenantId, email: 'viewer@send.test',
      name: 'Viewer', status: 'active', roleId: viewerRole._id, passwordHash: owner.passwordHash }));
    const login = async (email: string) => {
      const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: 'send-test',
        email, password: 'test-password-123' });
      expect(response.status).toBe(201);
      return (response.body as { accessToken: string }).accessToken;
    };
    ownerToken = await login('owner@send.test');
    viewerToken = await login('viewer@send.test');
    const account = await request(app.getHttpServer()).post('/api/v1/whatsapp/accounts').set(auth(ownerToken)).send({ label: 'Sender' });
    accountId = (account.body as { _id: string })._id;
    await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${viewer._id}`).set(auth(ownerToken)).send({ level: 'view' });
    const contact = await runInTenant(tenantId, () => contacts.create({ tenantId, waId: '201001234567@s.whatsapp.net',
      isGroup: false, tags: [], customFields: {} }));
    const conversation = await runInTenant(tenantId, () => conversations.create({ tenantId: new Types.ObjectId(tenantId),
      accountId: new Types.ObjectId(accountId), contactId: contact._id, status: 'open', lastMessageAt: new Date(),
      lastMessagePreview: '', lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 }));
    conversationId = conversation._id.toString();
  }, 180_000);
  afterAll(async () => { await app?.close(); await mongo?.stop(); });

  it('blocks view-only send and cloud-only type, and deduplicates a text send', async () => {
    const body = { type: 'text', accountId, conversationId, clientMessageId: crypto.randomUUID(), text: 'Hello' };
    const invalid = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({
      type: 'text', accountId, clientMessageId: crypto.randomUUID(), text: 'Missing destination'
    });
    expect(invalid.status).toBe(400);
    expect((await request(app.getHttpServer()).post('/api/v1/messages').set(auth(viewerToken)).send(body)).status).toBe(403);
    const unsupported = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({ ...body,
      clientMessageId: crypto.randomUUID(), type: 'template', name: 'hello', language: 'en', components: {} });
    expect(unsupported.status).toBe(422);
    const first = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send(body);
    expect(first.status).toBe(201);
    const sent = await runInTenant(tenantId, async () =>
      await messages.findOne({ _id: (first.body as { _id: string })._id }).lean());
    expect(sent?.poll).toBeUndefined();
    expect(sent?.pollVote).toBeUndefined();
    const second = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send(body);
    expect(second.status).toBe(201);
    expect((second.body as { _id: string })._id).toBe((first.body as { _id: string })._id);
    expect(queue.send).toHaveBeenCalledTimes(1);
    const visible = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages`).set(auth(ownerToken));
    expect((visible.body as { items: unknown[] }).items).toHaveLength(1);
    await messages.collection.updateOne({ _id: new Types.ObjectId((first.body as { _id: string })._id), tenantId: new Types.ObjectId(tenantId) },
      { $set: { poll: { options: [] }, pollVote: { selectedOptionHashes: [] } } });
    const legacy = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages`).set(auth(ownerToken));
    const legacyText = (legacy.body as { items: { type: string; poll?: unknown; pollVote?: unknown }[] }).items[0];
    expect(legacyText?.type).toBe('text');
    expect(legacyText?.poll).toBeUndefined();
    expect(legacyText?.pollVote).toBeUndefined();
  });

  it('validates media by bytes, stores it, sends it once and blocks viewer upload', async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const denied = await request(app.getHttpServer()).post('/api/v1/media/upload').set(auth(viewerToken))
      .field('accountId', accountId).field('kind', 'image').attach('file', bytes, 'picture.jpg');
    expect(denied.status).toBe(403);
    const invalid = await request(app.getHttpServer()).post('/api/v1/media/upload').set(auth(ownerToken))
      .field('accountId', accountId).field('kind', 'image').attach('file', Buffer.from('not a JPEG'), 'picture.jpg');
    expect(invalid.status).toBe(422);
    const upload = await request(app.getHttpServer()).post('/api/v1/media/upload').set(auth(ownerToken))
      .field('accountId', accountId).field('kind', 'image').attach('file', bytes, 'picture.jpg');
    expect(upload.status).toBe(201);
    const mediaId = (upload.body as { mediaId: string }).mediaId;
    const sent = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({
      type: 'image', accountId, conversationId, clientMessageId: crypto.randomUUID(), mediaId, caption: 'Photo'
    });
    expect(sent.status).toBe(201);
    expect((await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}`).set(auth(ownerToken))).status).toBe(200);
  });

  it('queues edit, revoke and forward only for authorized users', async () => {
    const sent = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({
      type: 'text', accountId, conversationId, clientMessageId: crypto.randomUUID(), text: 'Change me'
    });
    const id = (sent.body as { _id: string })._id;
    expect((await request(app.getHttpServer()).patch(`/api/v1/messages/${id}`).set(auth(viewerToken)).send({ text: 'No' })).status).toBe(403);
    expect((await request(app.getHttpServer()).patch(`/api/v1/messages/${id}`).set(auth(ownerToken)).send({ text: 'Yes' })).status).toBe(200);
    expect((await request(app.getHttpServer()).post(`/api/v1/messages/${id}/forward`).set(auth(ownerToken)).send({ conversationIds: [conversationId] })).status).toBe(201);
    expect((await request(app.getHttpServer()).delete(`/api/v1/messages/${id}?scope=me`).set(auth(ownerToken))).status).toBe(200);
    const after = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages`).set(auth(ownerToken));
    expect((after.body as { items: { _id: string }[] }).items.some(item => item._id === id)).toBe(false);
  });

  it('transcodes a voice upload to Ogg/Opus', async () => {
    const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1',
      '-f', 'wav', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 });
    expect(generated.status).toBe(0);
    const response = await request(app.getHttpServer()).post('/api/v1/media/upload').set(auth(ownerToken))
      .field('accountId', accountId).field('kind', 'voice').attach('file', generated.stdout, 'voice.wav');
    expect(response.status).toBe(201);
    expect((response.body as { mimeType: string }).mimeType).toBe('audio/ogg');
  }, 20_000);

  it('validates H.264 video and generates a thumbnail', async () => {
    const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
    { maxBuffer: 2 * 1024 * 1024 });
    expect(generated.status).toBe(0);
    const response = await request(app.getHttpServer()).post('/api/v1/media/upload').set(auth(ownerToken))
      .field('accountId', accountId).field('kind', 'video').attach('file', generated.stdout, 'video.mp4');
    expect(response.status).toBe(201);
    expect((response.body as { thumbnailAvailable: boolean }).thumbnailAvailable).toBe(true);
  }, 20_000);

  it('marks an unavailable number as failed and permits manual retry', async () => {
    queue.send.mockResolvedValueOnce(false);
    const failed = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({
      type: 'text', accountId, conversationId, clientMessageId: crypto.randomUUID(), text: 'Retry later'
    });
    expect(failed.status).toBe(503);
    expect((failed.body as { code: string; messageId: string }).code).toBe('ACCOUNT_NOT_RUNNING');
    expect((failed.body as { messageId: string }).messageId).toMatch(/^[a-f0-9]{24}$/);
    const page = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages`).set(auth(ownerToken));
    const message = (page.body as { items: { _id: string; text: string; status: string }[] }).items.find(item => item.text === 'Retry later');
    expect(message?.status).toBe('failed');
    const retried = await request(app.getHttpServer()).post(`/api/v1/messages/${message?._id}/retry`).set(auth(ownerToken));
    expect(retried.status).toBe(201);
    expect((retried.body as { accepted: boolean }).accepted).toBe(true);
  });

  it('starts a conversation from a phone destination', async () => {
    const result = await request(app.getHttpServer()).post('/api/v1/messages').set(auth(ownerToken)).send({
      type: 'text', accountId, to: '+20 100 999 8888', clientMessageId: crypto.randomUUID(), text: 'New contact'
    });
    expect(result.status).toBe(201);
    expect((result.body as { conversationId: string }).conversationId).toMatch(/^[a-f0-9]{24}$/);
    const page = await request(app.getHttpServer()).get('/api/v1/conversations?q=201009998888').set(auth(ownerToken));
    expect((page.body as { items: unknown[] }).items).toHaveLength(1);
  });
});
