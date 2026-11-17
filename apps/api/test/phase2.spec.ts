import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { io, type Socket } from 'socket.io-client';
import { runInTenant } from '../src/common/tenant-context.js';
import { bootstrapTenant } from '../src/modules/tenants/bootstrap-tenant.js';
import { type TenantRecord } from '../src/modules/tenants/tenant.schema.js';
import { type RoleRecord } from '../src/modules/roles/role.schema.js';
import { type UserRecord } from '../src/modules/users/user.schema.js';
import { RedisBusService } from '../src/modules/access/redis-bus.service.js';

interface LoginResult { accessToken: string }
interface AccountResult { _id: string; label: string }

describe('Phase 2 account and Socket isolation', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let ownerToken: string;
  let readerToken: string;
  let foreignToken: string;
  let tenantId: string;
  let readerId: string;
  let accountId: string;
  let bus: RedisBusService;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.JWT_ACCESS_SECRET = 'phase2-test-access-secret-that-is-long-enough';
    process.env.JWT_REFRESH_SECRET = 'phase2-test-refresh-secret-that-is-long-enough';
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    bus = module.get(RedisBusService);
    const tenants = module.get<Model<TenantRecord>>(getModelToken('Tenant'));
    const roles = module.get<Model<RoleRecord>>(getModelToken('Role'));
    const users = module.get<Model<UserRecord>>(getModelToken('User'));
    tenantId = await bootstrapTenant({ tenants, roles, users }, {
      slug: 'phase-two', name: 'Phase Two', ownerEmail: 'owner@two.test', ownerPassword: 'test-password-123'
    });
    await bootstrapTenant({ tenants, roles, users }, {
      slug: 'other-tenant', name: 'Other Tenant', ownerEmail: 'owner@other.test', ownerPassword: 'test-password-123'
    });
    readerId = await runInTenant(tenantId, async () => {
      const role = await roles.create({ tenantId, name: 'Number Reader', permissions: ['accounts:read', 'accounts:connect'], isSystem: false });
      const user = await users.create({ tenantId, email: 'reader@two.test', name: 'Reader', status: 'active', roleId: role._id,
        passwordHash: (await users.findOne({ email: 'owner@two.test' }).select('+passwordHash'))?.passwordHash });
      return user._id.toString();
    });
    const login = async (tenantSlug: string, email: string) => {
      const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug, email, password: 'test-password-123' });
      expect(response.status).toBe(201);
      return (response.body as LoginResult).accessToken;
    };
    ownerToken = await login('phase-two', 'owner@two.test');
    readerToken = await login('phase-two', 'reader@two.test');
    foreignToken = await login('other-tenant', 'owner@other.test');
  }, 180_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await app?.close();
    await mongo?.stop();
  });

  it('creates 20 numbers with no code limit and hides all from a non-member', async () => {
    for (let i = 0; i < 20; i++) {
      const response = await request(app.getHttpServer()).post('/api/v1/whatsapp/accounts')
        .set('Authorization', `Bearer ${ownerToken}`).send({ label: `Number ${i}` });
      expect(response.status).toBe(201);
      if (i === 0) accountId = (response.body as AccountResult)._id;
    }
    const ownerList = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${ownerToken}`);
    const readerList = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${readerToken}`);
    const foreignList = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${foreignToken}`);
    expect((ownerList.body as AccountResult[])).toHaveLength(20);
    expect(readerList.body).toEqual([]);
    expect(foreignList.body).toEqual([]);
    const hidden = await request(app.getHttpServer()).get(`/api/v1/whatsapp/accounts/${accountId}`).set('Authorization', `Bearer ${readerToken}`);
    expect(hidden.status).toBe(404);
    const crossTenant = await request(app.getHttpServer()).get(`/api/v1/whatsapp/accounts/${accountId}`).set('Authorization', `Bearer ${foreignToken}`);
    expect(crossTenant.status).toBe(404);
  });

  it('grants and revokes number access at query level', async () => {
    const grant = await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ level: 'view' });
    expect(grant.status).toBe(200);
    const list = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${readerToken}`);
    expect((list.body as AccountResult[]).map(account => account._id)).toEqual([accountId]);
    const denied = await request(app.getHttpServer()).post(`/api/v1/whatsapp/accounts/${accountId}/connect`)
      .set('Authorization', `Bearer ${readerToken}`);
    expect(denied.status).toBe(404);
    const promote = await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ level: 'manage' });
    expect(promote.status).toBe(200);
    const allowed = await request(app.getHttpServer()).post(`/api/v1/whatsapp/accounts/${accountId}/connect`)
      .set('Authorization', `Bearer ${readerToken}`);
    expect(allowed.status).toBe(201);
    await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ level: 'view' });
    const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${readerToken}`);
    expect((me.body as { accountMemberships: unknown[] }).accountMemberships).toHaveLength(1);
    const revoke = await request(app.getHttpServer()).delete(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(revoke.status).toBe(200);
    const after = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${readerToken}`);
    expect(after.body).toEqual([]);
  });

  it('changes Socket rooms immediately and sends QR only to managers', async () => {
    const connect = async (token: string): Promise<Socket> => {
      const socket = io(`${baseUrl}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('ready', resolve);
        socket.once('connect_error', reject);
        setTimeout(() => reject(new Error('Socket ready timeout')), 5000);
      });
      return socket;
    };
    const owner = await connect(ownerToken);
    const reader = await connect(readerToken);
    const foreign = await connect(foreignToken);
    const readerStatus: string[] = [];
    const readerQr: string[] = [];
    const ownerQr: string[] = [];
    const foreignStatus: string[] = [];
    reader.on('account:status', (event: { accountId: string }) => readerStatus.push(event.accountId));
    reader.on('account:qr', (event: { accountId: string }) => readerQr.push(event.accountId));
    owner.on('account:qr', (event: { accountId: string }) => ownerQr.push(event.accountId));
    foreign.on('account:status', (event: { accountId: string }) => foreignStatus.push(event.accountId));

    await bus.publish({ type: 'wa.connection', accountId, tenantId, status: 'connecting' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(readerStatus).toEqual([]);
    expect(foreignStatus).toEqual([]);

    const changed = new Promise<void>(resolve => reader.once('access:updated', () => resolve()));
    await request(app.getHttpServer()).put(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ level: 'view' });
    await changed;
    await bus.publish({ type: 'wa.qr', accountId, tenantId, qr: 'secret-qr' });
    await bus.publish({ type: 'wa.connection', accountId, tenantId, status: 'connected' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ownerQr).toEqual([accountId]);
    expect(readerQr).toEqual([]);
    expect(readerStatus).toEqual([accountId]);
    expect(foreignStatus).toEqual([]);

    const revoked = new Promise<void>(resolve => reader.once('access:updated', () => resolve()));
    await request(app.getHttpServer()).delete(`/api/v1/whatsapp/accounts/${accountId}/members/${readerId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    await revoked;
    await bus.publish({ type: 'wa.connection', accountId, tenantId, status: 'disconnected' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(readerStatus).toEqual([accountId]);
    expect(foreignStatus).toEqual([]);
  }, 20_000);

  it('removes deleted numbers from rooms and lists', async () => {
    const owner = sockets[0]!;
    const updated = new Promise<void>(resolve => owner.once('access:updated', () => resolve()));
    const response = await request(app.getHttpServer()).delete(`/api/v1/whatsapp/accounts/${accountId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(response.status).toBe(200);
    await updated;
    const list = await request(app.getHttpServer()).get('/api/v1/whatsapp/accounts').set('Authorization', `Bearer ${ownerToken}`);
    expect((list.body as AccountResult[])).toHaveLength(19);
    const received: string[] = [];
    owner.on('account:status', (event: { accountId: string }) => received.push(event.accountId));
    await bus.publish({ type: 'wa.connection', accountId, tenantId, status: 'disconnected' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received).toEqual([]);
  });
});
