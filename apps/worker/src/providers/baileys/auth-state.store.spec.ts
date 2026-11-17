import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connect, connection, disconnect, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { type Lease, type LeaseBackend, LeaseService } from '../../session/lease.service.js';
import { EncryptedAuthStateStore } from './auth-state.store.js';

class MemoryLeases implements LeaseBackend {
  currentLease: Lease | null = null;
  counter = 0;
  async acquire(accountId: string, workerId: string): Promise<Lease | null> {
    if (this.currentLease) return null;
    this.currentLease = { accountId, workerId, fencingToken: ++this.counter };
    return this.currentLease;
  }
  async renew(lease: Lease): Promise<boolean> { return this.currentLease?.fencingToken === lease.fencingToken; }
  async release(lease: Lease): Promise<boolean> {
    if (!(await this.renew(lease))) return false;
    this.currentLease = null;
    return true;
  }
  async current(): Promise<Lease | null> { return this.currentLease; }
}

describe('encrypted Baileys auth state', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
    await connect(mongo.getUri());
  }, 180_000);
  afterAll(async () => { await disconnect(); await mongo?.stop(); });

  it('encrypts credentials and rejects stale fencing tokens after failover', async () => {
    const backend = new MemoryLeases();
    const key = randomBytes(32).toString('base64');
    const account = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() };
    const firstLease = new LeaseService(backend, 'worker-a', 30_000);
    const first = await firstLease.acquire(account.id);
    expect(first?.fencingToken).toBe(1);
    const firstStore = new EncryptedAuthStateStore(connection, firstLease, key);
    const firstState = await firstStore.load(account, first!.fencingToken);
    firstState.state.creds.advSecretKey = 'private-test-marker';
    await firstState.saveCreds();
    const raw = await connection.collection('wa_auth_states').findOne({ accountId: new Types.ObjectId(account.id), key: 'creds' });
    expect(raw?.['valueEnc']).toBeTypeOf('string');
    expect(raw?.['valueEnc']).not.toContain('private-test-marker');
    await firstLease.release(first!);

    const secondLease = new LeaseService(backend, 'worker-b', 30_000);
    const second = await secondLease.acquire(account.id);
    expect(second?.fencingToken).toBe(2);
    const secondStore = new EncryptedAuthStateStore(connection, secondLease, key);
    const secondState = await secondStore.load(account, second!.fencingToken);
    expect(secondState.state.creds.advSecretKey).toBe('private-test-marker');
    secondState.state.creds.advSecretKey = 'new-owner-secret';
    await secondState.saveCreds();
    await expect(firstState.saveCreds()).rejects.toThrow('STALE_SESSION_FENCE');
    expect((await connection.collection('wa_auth_states').findOne({ accountId: new Types.ObjectId(account.id), key: 'creds' }))?.['fencingToken']).toBe(2);
  });
});
