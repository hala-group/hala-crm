import { type Connection, Types } from 'mongoose';
import { CLOUD_API_CAPABILITIES, type MediaSource, type ProviderAccount, type ProviderEvent, type ProviderSendRequest, type WhatsAppProvider } from '@hala/shared';
import { decryptSecret } from '@hala/shared/secrets';

interface CloudConfig { phoneNumberId: string; tokenEnc: string }

export class CloudApiProvider implements WhatsAppProvider {
  readonly name = 'cloud_api';
  readonly capabilities = new Set(CLOUD_API_CAPABILITIES);
  constructor(private readonly db: Connection, private readonly key: string, private readonly graphVersion: string) {}

  private async config(account: ProviderAccount): Promise<CloudConfig> {
    const record = await this.db.collection('whatsapp_accounts').findOne({
      _id: new Types.ObjectId(account.id), tenantId: new Types.ObjectId(account.tenantId), provider: 'cloud_api'
    }, { projection: { providerConfig: 1 } });
    const value = record?.['providerConfig'] as CloudConfig | undefined;
    if (!value?.phoneNumberId || !value.tokenEnc) throw new Error('Cloud API configuration missing');
    return value;
  }

  private async graph(account: ProviderAccount, path: string, init: RequestInit = {}): Promise<unknown> {
    const config = await this.config(account);
    const token = decryptSecret(config.tokenEnc, this.key);
    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }
    });
    if (!response.ok) throw new Error(`CLOUD_API_HTTP_${response.status}`);
    return response.json();
  }

  async open(account: ProviderAccount, _fencingToken: number, emit: (event: ProviderEvent) => Promise<void>) {
    if (!this.graphVersion) throw new Error('CLOUD_GRAPH_VERSION is required');
    const config = await this.config(account);
    const metadata = await this.graph(account, config.phoneNumberId) as { display_phone_number?: string };
    await emit({ type: 'wa.connection', tenantId: account.tenantId, accountId: account.id,
      status: 'connected', phoneNumber: metadata.display_phone_number });
    return { close: async () => {} };
  }
  async logout(_account: ProviderAccount): Promise<void> {}

  async send(account: ProviderAccount, request: ProviderSendRequest): Promise<string> {
    const config = await this.config(account);
    const input = request.input;
    const to = request.jid.split('@')[0];
    if (!to || !/^\d+$/.test(to)) throw new Error('CLOUD_API_REQUIRES_PHONE_DESTINATION');
    let body: Record<string, unknown>;
    if (input.type === 'text') body = { type: 'text', text: { body: input.text, preview_url: input.linkPreview } };
    else if (input.type === 'template') body = { type: 'template', template: { name: input.name, language: { code: input.language }, components: input.components } };
    else if (input.type === 'interactive') body = { type: 'interactive', interactive: {
      ...(input.data && typeof input.data === 'object' ? input.data : {}),
      type: input.kind === 'buttons' ? 'button' : 'list', body: { text: input.body }
    } };
    else if (input.type === 'location') body = { type: 'location', location: { latitude: input.lat, longitude: input.lng, name: input.name, address: input.address } };
    else if (input.type === 'contacts') body = { type: 'contacts', contacts: input.contacts.map(contact => ({
      name: { formatted_name: contact.name, first_name: contact.name }, phones: contact.phones.map(phone => ({ phone }))
    })) };
    else if (input.type === 'reaction') body = { type: 'reaction', reaction: { message_id: request.target?.id, emoji: input.emoji } };
    else if (['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(input.type)) {
      if (!request.media) throw new Error('CLOUD_API_MEDIA_MISSING');
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('file', new Blob([new Uint8Array(request.media)], { type: request.mimeType ?? 'application/octet-stream' }), request.fileName ?? 'upload');
      const uploaded = await this.graph(account, `${config.phoneNumberId}/media`, { method: 'POST', body: form }) as { id?: string };
      if (!uploaded.id) throw new Error('CLOUD_API_MEDIA_ID_MISSING');
      const type = input.type === 'voice' ? 'audio' : input.type;
      body = { type, [type]: { id: uploaded.id, ...('caption' in input && input.caption ? { caption: input.caption } : {}),
        ...(input.type === 'document' ? { filename: input.fileName ?? request.fileName } : {}),
        ...(input.type === 'voice' ? { voice: true } : {}) } };
    } else throw new Error('UNSUPPORTED_BY_PROVIDER');
    if (request.quoted) body['context'] = { message_id: request.quoted.id };
    const result = await this.graph(account, `${config.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body })
    }) as { messages?: { id: string }[] };
    const id = result.messages?.[0]?.id;
    if (!id) throw new Error('CLOUD_API_MESSAGE_ID_MISSING');
    return id;
  }

  async markRead(account: ProviderAccount, keys: { id: string }[]): Promise<void> {
    const config = await this.config(account);
    for (const key of keys) await this.graph(account, `${config.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: key.id })
    });
  }

  async download(account: ProviderAccount, source: MediaSource): Promise<Buffer> {
    if (!source.cloudMediaId) throw new Error('Cloud media ID missing');
    const metadata = await this.graph(account, source.cloudMediaId) as { url?: string };
    if (!metadata.url) throw new Error('Cloud media URL missing');
    const mediaUrl = new URL(metadata.url);
    if (mediaUrl.protocol !== 'https:' || !['lookaside.fbsbx.com', 'graph.facebook.com'].includes(mediaUrl.hostname)) {
      throw new Error('Invalid Cloud media URL');
    }
    const config = await this.config(account);
    const response = await fetch(metadata.url, { headers: { Authorization: `Bearer ${decryptSecret(config.tokenEnc, this.key)}` } });
    if (!response.ok) throw new Error(`CLOUD_MEDIA_HTTP_${response.status}`);
    const limit = Number(process.env.MEDIA_MAX_BYTES ?? 50 * 1024 * 1024);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('Media exceeds MEDIA_MAX_BYTES');
    return bytes;
  }
}
