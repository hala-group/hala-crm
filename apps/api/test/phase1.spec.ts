import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { hash, argon2id } from 'argon2';
import { runInTenant } from '../src/common/tenant-context.js';
import { type TenantRecord } from '../src/modules/tenants/tenant.schema.js';
import { type RoleRecord } from '../src/modules/roles/role.schema.js';
import { type UserRecord } from '../src/modules/users/user.schema.js';
import { bootstrapTenant } from '../src/modules/tenants/bootstrap-tenant.js';

interface LoginBody { accessToken: string }

describe('Phase 1 tenant and permission isolation', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let tenantA: string;
  let tenantB: string;
  let userB: string;
  let ownerToken: string;
  let ownerCookie: string;
  let readerToken: string;
  let users: Model<UserRecord>;
  let roles: Model<RoleRecord>;
  let tenants: Model<TenantRecord>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.JWT_ACCESS_SECRET = 'phase1-test-access-secret-that-is-long-enough';
    process.env.JWT_REFRESH_SECRET = 'phase1-test-refresh-secret-that-is-long-enough';
    process.env.BOOTSTRAP_TENANT_SLUG = 'tenant-a';
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.init();
    tenants = module.get<Model<TenantRecord>>(getModelToken('Tenant'));
    roles = module.get<Model<RoleRecord>>(getModelToken('Role'));
    users = module.get<Model<UserRecord>>(getModelToken('User'));
    const a = await tenants.create({ slug: 'tenant-a', name: 'Tenant A' });
    const b = await tenants.create({ slug: 'tenant-b', name: 'Tenant B' });
    tenantA = a._id.toString();
    tenantB = b._id.toString();
    const passwordHash = await hash('test-password-123', { type: argon2id });
    await runInTenant(tenantA, async () => {
      const owner = await roles.create({ tenantId: a._id, name: 'owner', key: 'owner', isSystem: true,
        permissions: ['users:read', 'users:create', 'users:update', 'users:delete', 'roles:read', 'roles:manage', 'audit:read'] });
      const reader = await roles.create({ tenantId: a._id, name: 'reader', isSystem: false, permissions: ['users:read'] });
      await users.create({ tenantId: a._id, email: 'owner@a.test', name: 'Owner A', status: 'active', roleId: owner._id, passwordHash });
      await users.create({ tenantId: a._id, email: 'reader@a.test', name: 'Reader A', status: 'active', roleId: reader._id, passwordHash });
    });
    await runInTenant(tenantB, async () => {
      const owner = await roles.create({ tenantId: b._id, name: 'owner', key: 'owner', isSystem: true, permissions: ['users:read'] });
      const foreign = await users.create({ tenantId: b._id, email: 'owner@b.test', name: 'Owner B', status: 'active', roleId: owner._id, passwordHash });
      userB = foreign._id.toString();
    });
    const ownerLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'owner@a.test', password: 'test-password-123' });
    const readerLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: 'tenant-a', email: 'reader@a.test', password: 'test-password-123' });
    expect(ownerLogin.status).toBe(201);
    expect(readerLogin.status).toBe(201);
    ownerToken = (ownerLogin.body as LoginBody).accessToken;
    ownerCookie = (ownerLogin.headers['set-cookie'] as string[])[0]?.split(';')[0] ?? '';
    readerToken = (readerLogin.body as LoginBody).accessToken;
  }, 180_000);

  afterAll(async () => { await app?.close(); await mongo?.stop(); });

  it('seeds the default roles and first owner idempotently', async () => {
    const input = { slug: 'seeded-tenant', name: 'Seeded Tenant', ownerEmail: 'seeded@example.com', ownerPassword: 'seed-password-123' };
    const first = await bootstrapTenant({ tenants, roles, users }, input);
    const second = await bootstrapTenant({ tenants, roles, users }, input);
    expect(second).toBe(first);
    const counts = await runInTenant(first, async () => ({
      roles: await roles.countDocuments(), users: await users.countDocuments()
    }));
    expect(counts).toEqual({ roles: 5, users: 1 });
  });

  it('adds tenant scope even when a caller supplies a different tenant ID', async () => {
    const leaked = await runInTenant(tenantA, async () => users.findOne({ tenantId: tenantB, _id: userB }).lean());
    expect(leaked).toBeNull();
  });

  it('restricts REST lists and object updates to the token tenant', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect((list.body as UserRecord[]).map(user => user.email).sort()).toEqual(['owner@a.test', 'reader@a.test']);
    const update = await request(app.getHttpServer()).patch(`/api/v1/users/${userB}`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'intrusion' });
    expect(update.status).toBe(404);
    const roleList = await request(app.getHttpServer()).get('/api/v1/roles').set('Authorization', `Bearer ${ownerToken}`);
    expect(roleList.status).toBe(200);
    expect((roleList.body as RoleRecord[]).every(role => role.tenantId.toString() === tenantA)).toBe(true);
  });

  it('rejects a read-only role at the policy guard and query layer', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${readerToken}`);
    expect(list.status).toBe(200);
    expect((list.body as UserRecord[]).every(user => user.tenantId.toString() === tenantA)).toBe(true);
    const create = await request(app.getHttpServer()).post('/api/v1/users/invite').set('Authorization', `Bearer ${readerToken}`)
      .send({ email: 'new@a.test', name: 'New', roleId: userB });
    expect(create.status).toBe(403);
  });

  it('creates a custom role and completes a one-use invitation', async () => {
    const roleResponse = await request(app.getHttpServer()).post('/api/v1/roles').set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Support', permissions: ['users:read'] });
    expect(roleResponse.status).toBe(201);
    const roleId = (roleResponse.body as { _id: string })._id;
    const invite = await request(app.getHttpServer()).post('/api/v1/users/invite').set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'new@a.test', name: 'New User', roleId });
    expect(invite.status).toBe(201);
    const token = (invite.body as { invitation: { token: string } }).invitation.token;
    const accept = await request(app.getHttpServer()).post('/api/v1/auth/accept-invite').send({ token, password: 'new-password-123' });
    expect(accept.status).toBe(201);
    const repeat = await request(app.getHttpServer()).post('/api/v1/auth/accept-invite').send({ token, password: 'new-password-123' });
    expect(repeat.status).toBe(401);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: 'tenant-a', email: 'new@a.test', password: 'new-password-123' });
    expect(login.status).toBe(201);
  });

  it('protects the last active owner', async () => {
    const owner = await runInTenant(tenantA, async () => users.findOne({ email: 'owner@a.test' }).lean());
    const response = await request(app.getHttpServer()).post(`/api/v1/users/${owner!._id}/suspend`).set('Authorization', `Bearer ${ownerToken}`);
    expect(response.status).toBe(403);
  });

  it('detects refresh reuse and invalidates access on logout', async () => {
    const refresh = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', ownerCookie);
    expect(refresh.status).toBe(201);
    const nextCookie = (refresh.headers['set-cookie'] as string[])[0]?.split(';')[0] ?? '';
    const replay = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', ownerCookie);
    expect(replay.status).toBe(401);
    const afterReplay = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', nextCookie);
    expect(afterReplay.status).toBe(401);

    const freshLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: 'tenant-a', email: 'owner@a.test', password: 'test-password-123' });
    const freshToken = (freshLogin.body as LoginBody).accessToken;
    const cookie = (freshLogin.headers['set-cookie'] as string[])[0]?.split(';')[0] ?? '';
    const logout = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${freshToken}`).set('Cookie', cookie);
    expect(logout.status).toBe(201);
    const denied = await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${freshToken}`);
    expect(denied.status).toBe(401);
  });
});
