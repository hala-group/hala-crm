import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { io, type Socket } from 'socket.io-client';
import { runInTenant } from '../src/common/tenant-context.js';
import { bootstrapTenant } from '../src/modules/tenants/bootstrap-tenant.js';
import { type TenantRecord } from '../src/modules/tenants/tenant.schema.js';
import { type RoleRecord } from '../src/modules/roles/role.schema.js';
import { type UserRecord } from '../src/modules/users/user.schema.js';
import { type ConversationRecord, type ContactRecord, type MessageRecord, type MediaRecord } from '../src/modules/inbox/inbox.schema.js';
import { RedisBusService } from '../src/modules/access/redis-bus.service.js';

describe('Phase 3 inbox isolation', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let bus: RedisBusService;
  let ownerToken: string;
  let agentToken: string;
  let outsiderToken: string;
  let tenantId: string;
  let accountId: string;
  let conversationId: string;
  let hiddenConversationId: string;
  let statusConversationId: string;
  let mediaId: string;
  let agentId: string;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.JWT_ACCESS_SECRET = 'phase3-test-access-secret-that-is-long-enough';
    process.env.JWT_REFRESH_SECRET = 'phase3-test-refresh-secret-that-is-long-enough';
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    bus = module.get(RedisBusService);
    const tenants = module.get<Model<TenantRecord>>(getModelToken('Tenant'));
    const roles = module.get<Model<RoleRecord>>(getModelToken('Role'));
    const users = module.get<Model<UserRecord>>(getModelToken('User'));
    const contacts = module.get<Model<ContactRecord>>(getModelToken('Contact'));
    const conversations = module.get<Model<ConversationRecord>>(getModelToken('Conversation'));
    const messages = module.get<Model<MessageRecord>>(getModelToken('Message'));
    const media = module.get<Model<MediaRecord>>(getModelToken('Media'));
    tenantId = await bootstrapTenant({ tenants, roles, users }, {
      slug: 'inbox-test', name: 'Inbox Test', ownerEmail: 'owner@inbox.test', ownerPassword: 'test-password-123'
    });
    const agentRole = await runInTenant(tenantId, () => roles.create({ tenantId, name: 'Agent',
      permissions: ['conversations:read', 'accounts:read'], isSystem: false }));
    const owner = await runInTenant(tenantId, async () => users.findOne({ email: 'owner@inbox.test' }).select('+passwordHash'));
    if (!owner) throw new Error('Missing owner');
    const agent = await runInTenant(tenantId, () => users.create({ tenantId, email: 'agent@inbox.test', name: 'Agent',
      status: 'active', roleId: agentRole._id, passwordHash: owner.passwordHash }));
    agentId = agent._id.toString();
    await runInTenant(tenantId, () => users.create({ tenantId, email: 'outsider@inbox.test', name: 'Outsider',
      status: 'active', roleId: agentRole._id, passwordHash: owner.passwordHash }));
    const login = async (email: string) => {
      const result = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: 'inbox-test', email, password: 'test-password-123' });
      expect(result.status).toBe(201);
      return (result.body as { accessToken: string }).accessToken;
    };
    ownerToken = await login('owner@inbox.test');
    agentToken = await login('agent@inbox.test');
    outsiderToken = await login('outsider@inbox.test');
    const account = await request(app.getHttpServer()).post('/api/v1/whatsapp/accounts')
      .set('Authorization', `Bearer ${ownerToken}`).send({ label: 'Inbox Number' });
    accountId = (account.body as { _id: string })._id;
    await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${agentId}`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ level: 'view' });
    const contact = await runInTenant(tenantId, () => contacts.create({ tenantId, waId: '201000000000@s.whatsapp.net',
      pushName: 'Visible Contact', isGroup: false, tags: [], customFields: {} }));
    const hiddenContact = await runInTenant(tenantId, () => contacts.create({ tenantId, waId: '201111111111@s.whatsapp.net',
      pushName: 'Hidden Contact', isGroup: false, tags: [], customFields: {} }));
    const statusContact = await runInTenant(tenantId, () => contacts.create({ tenantId, waId: 'status@broadcast',
      pushName: 'aisha', isGroup: false, tags: [], customFields: {} }));
    const base = { tenantId: new Types.ObjectId(tenantId), accountId: new Types.ObjectId(accountId), status: 'open' as const,
      lastMessageAt: new Date(), lastMessagePreview: 'Hello', lastMessageType: 'text' as const,
      lastMessageDirection: 'in' as const, unreadCount: 1 };
    const visible = await runInTenant(tenantId, () => conversations.create({ ...base, contactId: contact._id }));
    const hidden = await runInTenant(tenantId, () => conversations.create({ ...base, contactId: hiddenContact._id,
      assignedUserId: owner._id }));
    const status = await runInTenant(tenantId, () => conversations.create({ ...base, contactId: statusContact._id }));
    conversationId = visible._id.toString(); hiddenConversationId = hidden._id.toString();
    statusConversationId = status._id.toString();
    const message = await runInTenant(tenantId, () => messages.create({ tenantId, accountId, conversationId: visible._id,
      contactId: contact._id, waMessageId: 'visible-wa', direction: 'in', type: 'document', status: 'delivered', timestamp: new Date() }));
    const asset = await runInTenant(tenantId, () => media.create({ tenantId, accountId, messageId: message._id,
      storageKey: `${tenantId}/${accountId}/${message._id}`, storageDriver: 'local', mimeType: 'application/pdf', status: 'ready' }));
    await runInTenant(tenantId, async () => { await messages.updateOne({ _id: message._id }, { $set: { mediaId: asset._id } }); });
    mediaId = asset._id.toString();
  }, 180_000);

  afterAll(async () => { for (const socket of sockets) socket.disconnect(); await app?.close(); await mongo?.stop(); });

  it('filters conversations, messages, search and media by account membership and assignment', async () => {
    const get = (token: string, path: string) => request(app.getHttpServer()).get(`/api/v1/${path}`).set('Authorization', `Bearer ${token}`);
    const visible = await get(agentToken, 'conversations');
    expect(visible.status).toBe(200);
    expect((visible.body as { items: { _id: string }[] }).items.map(item => item._id)).toEqual([conversationId]);
    expect((await get(agentToken, 'conversations?q=Hidden')).body.items).toEqual([]);
    expect((await get(outsiderToken, 'conversations')).body.items).toEqual([]);
    expect((await get(agentToken, `conversations/${hiddenConversationId}/messages`)).status).toBe(404);
    expect((await get(ownerToken, `conversations/${statusConversationId}`)).status).toBe(404);
    expect((await get(agentToken, 'conversations')).body.items).toHaveLength(1);
    expect((await get(ownerToken, 'conversations')).body.items).toHaveLength(2);
    expect((await get(agentToken, `conversations/${conversationId}/messages`)).body.items).toHaveLength(1);
    expect((await get(outsiderToken, `conversations/${conversationId}/messages`)).status).toBe(404);
    expect((await get(outsiderToken, `media/${mediaId}`)).status).toBe(404);
    expect((await get(agentToken, `conversations/${conversationId}/media`)).body.items).toHaveLength(1);
    expect((await get(outsiderToken, `conversations/${conversationId}/media`)).status).toBe(404);
    expect((await get(agentToken, `conversations/${hiddenConversationId}/media`)).status).toBe(404);
    expect((await request(app.getHttpServer()).post(`/api/v1/conversations/${hiddenConversationId}/profile/refresh`)
      .set('Authorization', `Bearer ${agentToken}`)).status).toBe(404);
    expect((await get(agentToken, `conversations/${conversationId}/avatar/status`)).body.status).toBe('missing');
    expect((await get(outsiderToken, `conversations/${conversationId}/avatar/status`)).status).toBe(404);
    expect((await get(agentToken, `conversations/${hiddenConversationId}/avatar`)).status).toBe(404);
    expect((await request(app.getHttpServer()).post(`/api/v1/conversations/${conversationId}/avatar/refresh`)
      .set('Authorization', `Bearer ${outsiderToken}`)).status).toBe(404);
  });

  it('shows only accessible shared groups in contact details', async () => {
    const contacts = app.get<Model<ContactRecord>>(getModelToken('Contact'));
    const conversations = app.get<Model<ConversationRecord>>(getModelToken('Conversation'));
    const group = await runInTenant(tenantId, () => contacts.create({ tenantId, waId: '12345@g.us',
      pushName: 'Private Group', isGroup: true, tags: [], customFields: {} }));
    await runInTenant(tenantId, () => conversations.create({ tenantId, accountId, contactId: group._id,
      status: 'open', assignedUserId: new Types.ObjectId(), lastMessageAt: new Date(),
      lastMessagePreview: '', lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 }));
    await runInTenant(tenantId, async () => { await conversations.updateOne({ _id: conversationId },
      { $set: { commonGroups: [{ id: '12345@g.us', name: 'Private Group' }] } }); });
    const get = (token: string) => request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect((await get(agentToken)).body.commonGroups).toEqual([]);
    expect((await get(ownerToken)).body.commonGroups).toEqual([{ id: '12345@g.us', name: 'Private Group' }]);
  });

  it('emits only accessible conversation events to sockets', async () => {
    const connect = async (token: string) => {
      const socket = io(`${baseUrl}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('ready', resolve); socket.once('connect_error', reject); });
      return socket;
    };
    const agent = await connect(agentToken);
    const outsider = await connect(outsiderToken);
    const received: string[] = [];
    const statuses: string[] = [];
    agent.on('message:new', (message: { waMessageId: string }) => received.push(message.waMessageId));
    outsider.on('message:new', (message: { waMessageId: string }) => received.push(`outside:${message.waMessageId}`));
    agent.on('message:status', (event: { messageId: string }) => statuses.push(event.messageId));
    outsider.on('message:status', (event: { messageId: string }) => statuses.push(`outside:${event.messageId}`));
    const payload = { _id: new Types.ObjectId().toString(), tenantId, accountId, conversationId,
      contactId: new Types.ObjectId().toString(), waMessageId: 'socket-visible', direction: 'in' as const,
      type: 'text' as const, timestamp: new Date().toISOString(), status: 'delivered' as const };
    await bus.publish({ type: 'message.created', tenantId, accountId, conversationId, assignedUserId: null, message: payload });
    await bus.publish({ type: 'message.created', tenantId, accountId, conversationId: hiddenConversationId,
      assignedUserId: new Types.ObjectId().toString(), message: { ...payload, waMessageId: 'socket-hidden' } });
    await bus.publish({ type: 'message.status', tenantId, accountId, conversationId,
      assignedUserId: null, messageId: 'visible-status', status: 'sent' });
    await bus.publish({ type: 'message.status', tenantId, accountId, conversationId: hiddenConversationId,
      assignedUserId: new Types.ObjectId().toString(), messageId: 'hidden-status', status: 'sent' });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(received).toEqual(['socket-visible']);
    expect(statuses).toEqual(['visible-status']);
  });
});
