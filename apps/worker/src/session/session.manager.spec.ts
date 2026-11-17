import { describe, expect, it } from 'vitest';
import { BAILEYS_CAPABILITIES, type HistorySyncTarget, type ProviderAccount, type ProviderEvent, type ProviderSession, type WhatsAppProvider } from '@hala/shared';
import { type Lease, type LeaseBackend, LeaseService } from './lease.service.js';
import { SessionManager, type SessionAccount, type SessionRepository } from './session.manager.js';

class MemoryLeaseBackend implements LeaseBackend {
  private readonly leases = new Map<string, Lease>();
  private readonly fences = new Map<string, number>();
  async acquire(accountId: string, workerId: string): Promise<Lease | null> {
    if (this.leases.has(accountId)) return null;
    const fencingToken = (this.fences.get(accountId) ?? 0) + 1;
    this.fences.set(accountId, fencingToken);
    const lease = { accountId, workerId, fencingToken };
    this.leases.set(accountId, lease);
    return lease;
  }
  async renew(lease: Lease): Promise<boolean> { return this.leases.get(lease.accountId)?.fencingToken === lease.fencingToken; }
  async release(lease: Lease): Promise<boolean> {
    if (!(await this.renew(lease))) return false;
    this.leases.delete(lease.accountId);
    return true;
  }
  async current(accountId: string): Promise<Lease | null> { return this.leases.get(accountId) ?? null; }
}

class FakeProvider implements WhatsAppProvider {
  readonly name = 'fake';
  readonly capabilities = new Set(BAILEYS_CAPABILITIES);
  readonly live = new Set<string>();
  readonly auth = new Set<string>();
  qrCount = 0;
  readonly historyRequests: Array<{ accountId: string; targets: HistorySyncTarget[] }> = [];
  async open(account: ProviderAccount, _fence: number, emit: (event: ProviderEvent) => Promise<void>): Promise<ProviderSession> {
    if (this.live.has(account.id)) throw new Error('Duplicate live session');
    this.live.add(account.id);
    if (!this.auth.has(account.id)) {
      this.qrCount++;
      this.auth.add(account.id);
      await emit({ type: 'wa.qr', accountId: account.id, tenantId: account.tenantId, qr: 'fake-qr' });
    }
    await emit({ type: 'wa.connection', accountId: account.id, tenantId: account.tenantId, status: 'connected' });
    return { close: async () => { this.live.delete(account.id); } };
  }
  async syncHistory(account: ProviderAccount, targets: HistorySyncTarget[]): Promise<number> {
    this.historyRequests.push({ accountId: account.id, targets });
    return targets.length;
  }
  async logout(account: ProviderAccount): Promise<void> { this.auth.delete(account.id); }
}

describe('distributed WhatsApp sessions', () => {
  it('requests older history without closing the active session', async () => {
    const account: SessionAccount = { id: 'history-account', tenantId: 'tenant-1', provider: 'baileys', desiredState: 'connected' };
    const repository: SessionRepository = { desiredAccounts: async () => [account], get: async () => account,
      update: async () => {}, clearAuth: async () => {} };
    const backend = new MemoryLeaseBackend();
    const provider = new FakeProvider();
    const manager = new SessionManager(new LeaseService(backend, 'history-worker', 30_000), repository, provider,
      { publish: async () => {} }, 10);
    await manager.tick();
    const targets: HistorySyncTarget[] = [{ jid: '201000000000@s.whatsapp.net', oldestMessageId: 'oldest', fromMe: false, timestampMs: 1_700_000_000_000 }];
    await expect(manager.requestHistory(account.id, account.tenantId, targets)).resolves.toBe(1);
    expect(provider.historyRequests).toEqual([{ accountId: account.id, targets }]);
    expect(manager.owns(account.id)).toBe(true);
    expect(provider.live.has(account.id)).toBe(true);
    await manager.stop();
  });
  it('spreads 200 live sessions over four FakeProvider workers without duplicate ownership', async () => {
    const accounts: SessionAccount[] = Array.from({ length: 200 }, (_, index) => ({
      id: `load-${index}`, tenantId: `tenant-${index % 4}`, provider: 'baileys', desiredState: 'connected'
    }));
    const repository: SessionRepository = { desiredAccounts: async () => accounts,
      get: async id => accounts.find(account => account.id === id) ?? null,
      update: async () => {}, clearAuth: async () => {} };
    const backend = new MemoryLeaseBackend();
    const provider = new FakeProvider();
    const sink = { publish: async (_event: ProviderEvent) => {} };
    const managers = Array.from({ length: 4 }, (_, index) => new SessionManager(
      new LeaseService(backend, `load-worker-${index}`, 30_000), repository, provider, sink, 50
    ));
    try {
      await Promise.all(managers.map(manager => manager.tick()));
      expect(managers.map(manager => manager.size)).toEqual([50, 50, 50, 50]);
      expect(provider.live.size).toBe(200);
      for (const account of accounts) expect(managers.filter(manager => manager.owns(account.id))).toHaveLength(1);
    } finally { await Promise.all(managers.map(manager => manager.stop())); }
    expect(provider.live.size).toBe(0);
  });
  it('distributes 20 accounts, has one owner per account, and fails over without a new QR', async () => {
    const accounts: SessionAccount[] = Array.from({ length: 20 }, (_, i) => ({
      id: `account-${i}`, tenantId: 'tenant-1', provider: 'baileys', desiredState: 'connected'
    }));
    const repository: SessionRepository = {
      desiredAccounts: async () => accounts,
      get: async id => accounts.find(account => account.id === id) ?? null,
      update: async () => {}, clearAuth: async () => {}
    };
    const backend = new MemoryLeaseBackend();
    const provider = new FakeProvider();
    const events: ProviderEvent[] = [];
    const sink = { publish: async (event: ProviderEvent) => { events.push(event); } };
    const a = new SessionManager(new LeaseService(backend, 'worker-a', 30_000), repository, provider, sink, 10);
    const b = new SessionManager(new LeaseService(backend, 'worker-b', 30_000), repository, provider, sink, 20);
    await a.tick();
    await b.tick();
    expect(a.size).toBe(10);
    expect(b.size).toBe(10);
    expect(provider.live.size).toBe(20);
    expect(provider.qrCount).toBe(20);
    expect(events.filter(event => event.type === 'wa.qr')).toHaveLength(20);
    for (const account of accounts) expect((await backend.current(account.id))?.workerId).toBe(a.owns(account.id) ? 'worker-a' : 'worker-b');
    await a.stop();
    await b.tick();
    expect(b.size).toBe(20);
    expect(provider.live.size).toBe(20);
    expect(provider.qrCount).toBe(20);
    await b.stop();
    expect(provider.live.size).toBe(0);
  });
});
