import { type ProviderAccount, type ProviderEvent, type ProviderSession, type WhatsAppProvider, type AccountCommand, type HistorySyncTarget, type SessionStatusEvent, type ProviderSendRequest, type ProviderMessageKey } from '@hala/shared';
import { type Lease, LeaseService } from './lease.service.js';

export interface SessionAccount extends ProviderAccount { desiredState: 'connected' | 'disconnected'; provider: 'baileys' | 'cloud_api' }
export interface SessionRepository {
  desiredAccounts(): Promise<SessionAccount[]>;
  get(id: string): Promise<SessionAccount | null>;
  update(event: SessionStatusEvent, workerId: string): Promise<void>;
  clearAuth(account: ProviderAccount): Promise<void>;
}
export interface SessionEvents { publish(event: ProviderEvent): Promise<void> }

interface RunningSession { account: SessionAccount; lease: Lease; session: ProviderSession; provider: WhatsAppProvider; openedAt: number; deactivate(): void }

export class SessionManager {
  private readonly running = new Map<string, RunningSession>();
  private readonly retryAfter = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private busy = false;
  constructor(
    private readonly leases: LeaseService,
    private readonly repository: SessionRepository,
    private readonly providers: WhatsAppProvider | readonly WhatsAppProvider[],
    private readonly events: SessionEvents,
    private readonly capacity: number
  ) {}

  get size(): number { return this.running.size; }
  get averageConnectionAgeMs(): number {
    if (!this.running.size) return 0;
    return [...this.running.values()].reduce((sum, entry) => sum + Date.now() - entry.openedAt, 0) / this.running.size;
  }
  owns(id: string): boolean { return this.running.has(id); }
  private providerFor(account: SessionAccount): WhatsAppProvider | undefined {
    const providers = Array.isArray(this.providers) ? this.providers : [this.providers];
    return providers.find(provider => provider.name === account.provider || provider.name === 'fake');
  }

  private async emit(event: ProviderEvent): Promise<void> {
    if (event.type === 'wa.qr' || event.type === 'wa.connection') await this.repository.update(event, this.leases.workerId);
    await this.events.publish(event);
    if (event.type === 'wa.connection' && (event.status === 'disconnected' || event.status === 'logged_out' || event.status === 'error')) {
      queueMicrotask(() => {
        void this.close(event.accountId, event.status === 'logged_out').then(() => {
          if (event.status !== 'logged_out') void this.tick();
        });
      });
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [id, entry] of this.running) {
        const current = await this.repository.get(id);
        if (!current || current.desiredState !== 'connected' || !(await this.leases.renew(entry.lease))) {
          await this.close(id, false);
        }
      }
      if (this.running.size >= this.capacity) return;
      const desired = await this.repository.desiredAccounts();
      for (const account of desired.sort(() => Math.random() - 0.5)) {
        if (this.running.size >= this.capacity) break;
        const provider = this.providerFor(account);
        if (!provider || this.running.has(account.id) || (this.retryAfter.get(account.id) ?? 0) > Date.now()) continue;
        const lease = await this.leases.acquire(account.id);
        if (!lease) continue;
        try {
          let accepting = true;
          let terminalDuringOpen: 'logged_out' | 'error' | null = null;
          const session = await provider.open(account, lease.fencingToken, async event => {
            if (!accepting) return;
            await this.leases.assertOwned(lease);
            await this.emit(event);
            if (event.type === 'wa.connection' && (event.status === 'logged_out' || event.status === 'error')) {
              terminalDuringOpen = event.status;
            }
          });
          this.running.set(account.id, { account, lease, session, provider, openedAt: Date.now(), deactivate: () => { accepting = false; } });
          if (terminalDuringOpen) await this.close(account.id, terminalDuringOpen === 'logged_out');
          this.failures.delete(account.id);
        } catch {
          await this.leases.release(lease);
          const failures = (this.failures.get(account.id) ?? 0) + 1;
          this.failures.set(account.id, failures);
          this.retryAfter.set(account.id, Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) + Math.random() * 1000);
          await this.emit({ type: 'wa.connection', accountId: account.id, tenantId: account.tenantId, status: 'error', error: 'Connection failed' });
        }
      }
    } finally { this.busy = false; }
  }

  async command(command: AccountCommand): Promise<void> {
    const entry = this.running.get(command.accountId);
    if (!entry || entry.account.tenantId !== command.tenantId) throw new Error('ACCOUNT_NOT_RUNNING');
    if (command.type === 'logout') await entry.provider.logout(entry.account);
    await this.close(command.accountId, command.type === 'logout');
  }

  private async active(accountId: string, tenantId: string): Promise<RunningSession> {
    const entry = this.running.get(accountId);
    if (!entry || entry.account.tenantId !== tenantId) throw new Error('ACCOUNT_NOT_RUNNING');
    await this.leases.assertOwned(entry.lease);
    return entry;
  }

  async send(accountId: string, tenantId: string, request: ProviderSendRequest): Promise<string> {
    const entry = await this.active(accountId, tenantId);
    const provider = entry.provider;
    if (!provider.send || !provider.capabilities.has(request.input.type) ||
      (request.quoted && !provider.capabilities.has('reply')) ||
      (request.input.mentions?.length && !provider.capabilities.has('mentions')) ||
      (request.forwarded && !provider.capabilities.has('forward'))) throw new Error('UNSUPPORTED_BY_PROVIDER');
    return provider.send(entry.account, request);
  }

  async requestHistory(accountId: string, tenantId: string, targets: HistorySyncTarget[]): Promise<number> {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.syncHistory || (entry.provider.name !== 'baileys' && entry.provider.name !== 'fake')) {
      throw new Error('UNSUPPORTED_BY_PROVIDER');
    }
    return entry.provider.syncHistory(entry.account, targets);
  }

  async fetchProfilePicture(accountId: string, tenantId: string, jid: string): Promise<Buffer | null> {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.fetchProfilePicture) return null;
    return entry.provider.fetchProfilePicture(entry.account, jid);
  }

  async fetchContactDetails(accountId: string, tenantId: string, jids: string[]) {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.fetchContactDetails) return null;
    return entry.provider.fetchContactDetails(entry.account, jids);
  }

  async edit(accountId: string, tenantId: string, jid: string, key: ProviderMessageKey, text: string): Promise<void> {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.edit || !entry.provider.capabilities.has('edit')) throw new Error('UNSUPPORTED_BY_PROVIDER');
    await entry.provider.edit(entry.account, jid, key, text);
  }

  async revoke(accountId: string, tenantId: string, jid: string, key: ProviderMessageKey): Promise<void> {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.revoke || !entry.provider.capabilities.has('revoke')) throw new Error('UNSUPPORTED_BY_PROVIDER');
    await entry.provider.revoke(entry.account, jid, key);
  }

  async markRead(accountId: string, tenantId: string, keys: ProviderMessageKey[]): Promise<void> {
    const entry = await this.active(accountId, tenantId);
    if (!entry.provider.markRead) throw new Error('UNSUPPORTED_BY_PROVIDER');
    await entry.provider.markRead(entry.account, keys);
  }

  async close(id: string, loggedOut: boolean): Promise<void> {
    const entry = this.running.get(id);
    if (!entry) return;
    this.running.delete(id);
    entry.deactivate();
    try { await entry.session.close(); }
    finally { await this.leases.release(entry.lease); }
    if (loggedOut) await this.repository.clearAuth(entry.account);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.running.keys()].map(id => this.close(id, false)));
  }
}
