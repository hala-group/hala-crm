import { BAILEYS_CAPABILITIES, type ProviderAccount, type ProviderEvent, type ProviderSendRequest, type WhatsAppProvider } from '@hala/shared';

/** Deterministic provider for isolated end-to-end tests; never enabled in production. */
export class FakeProvider implements WhatsAppProvider {
  readonly name = 'fake';
  readonly capabilities = new Set(BAILEYS_CAPABILITIES);
  private readonly sessions = new Set<string>();
  async open(account: ProviderAccount, _fence: number, emit: (event: ProviderEvent) => Promise<void>) {
    if (this.sessions.has(account.id)) throw new Error('Duplicate fake session');
    this.sessions.add(account.id);
    await emit({ type: 'wa.connection', tenantId: account.tenantId, accountId: account.id, status: 'connected', phoneNumber: '15550000000@s.whatsapp.net' });
    return { close: async () => { this.sessions.delete(account.id); } };
  }
  async logout(_account: ProviderAccount): Promise<void> {}
  async send(_account: ProviderAccount, request: ProviderSendRequest): Promise<string> { return request.messageId; }
  async edit(): Promise<void> {}
  async revoke(): Promise<void> {}
  async markRead(): Promise<void> {}
}
