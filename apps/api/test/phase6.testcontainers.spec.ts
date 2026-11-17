import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createConnection, Types } from 'mongoose';
import { Redis } from 'ioredis';
import { accountSchema } from '../src/modules/whatsapp-accounts/account.schema.js';
import { runInTenant } from '../src/common/tenant-context.js';

describe.skipIf(process.env.HALA_TESTCONTAINERS !== '1')('Phase 6 Mongo/Redis containers', () => {
  let mongo: StartedTestContainer;
  let redisContainer: StartedTestContainer;

  beforeAll(async () => {
    [mongo, redisContainer] = await Promise.all([
      new GenericContainer('mongo:8').withExposedPorts(27017).withWaitStrategy(Wait.forListeningPorts()).start(),
      new GenericContainer('redis:8-alpine').withExposedPorts(6379).withWaitStrategy(Wait.forListeningPorts()).start()
    ]);
  }, 300_000);
  afterAll(async () => { await Promise.all([mongo?.stop(), redisContainer?.stop()]); }, 60_000);

  it('keeps tenant documents isolated and enforces one Redis lease owner', async () => {
    const db = createConnection(`mongodb://${mongo.getHost()}:${mongo.getMappedPort(27017)}/hala_test`);
    await db.asPromise();
    const redis = new Redis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`);
    try {
      const Account = db.model('WhatsAppAccount', accountSchema);
      const first = new Types.ObjectId().toString();
      const second = new Types.ObjectId().toString();
      await runInTenant(first, () => Account.create({ tenantId: first, label: 'First', provider: 'baileys' }));
      await runInTenant(second, () => Account.create({ tenantId: second, label: 'Second', provider: 'baileys' }));
      expect((await runInTenant(first, async () => await Account.find().lean())).map(account => account.label)).toEqual(['First']);
      expect((await runInTenant(second, async () => await Account.find().lean())).map(account => account.label)).toEqual(['Second']);
      const leases = await Promise.all(Array.from({ length: 10 }, (_, index) => redis.set('phase6:lease', `worker-${index}`, 'NX', 'EX', 30)));
      expect(leases.filter(result => result === 'OK')).toHaveLength(1);
      await redis.del('phase6:lease');
    } finally { redis.disconnect(); await db.close(); }
  }, 30_000);
});
