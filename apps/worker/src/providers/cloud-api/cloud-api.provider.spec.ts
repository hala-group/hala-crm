import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type Connection, Types } from 'mongoose';
import { encryptSecret } from '@hala/shared/secrets';
import { CloudApiProvider } from './cloud-api.provider.js';

describe('CloudApiProvider', () => {
  it('sends templates and interactive messages through the Graph API with a decrypted token', async () => {
    const tenantId = new Types.ObjectId().toString();
    const id = new Types.ObjectId().toString();
    const key = randomBytes(32).toString('base64');
    const findOne = vi.fn(async () => ({ providerConfig: { phoneNumberId: '1234567890', tokenEnc: encryptSecret('private-token', key) } }));
    const db = { collection: () => ({ findOne }) } as unknown as Connection;
    const provider = new CloudApiProvider(db, key, 'v23.0');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer private-token');
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.123' }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const account = { id, tenantId };
      const base = { accountId: id, to: '+201234567890', clientMessageId: crypto.randomUUID() };
      const template = await provider.send(account, { jid: '201234567890@s.whatsapp.net', messageId: 'local',
        input: { ...base, type: 'template', name: 'hello_world', language: 'en_US', components: [] } });
      expect(template).toBe('wamid.123');
      const interactive = await provider.send(account, { jid: '201234567890@s.whatsapp.net', messageId: 'local',
        input: { ...base, type: 'interactive', kind: 'buttons', body: 'Choose', data: { action: { buttons: [] } } } });
      expect(interactive).toBe('wamid.123');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse((fetchMock.mock.calls[1]![1].body as string)) as { interactive: { type: string; body: { text: string } } };
      expect(body.interactive).toMatchObject({ type: 'button', body: { text: 'Choose' } });
      expect(findOne).toHaveBeenCalledWith({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(tenantId), provider: 'cloud_api' },
        { projection: { providerConfig: 1 } });
    } finally { vi.unstubAllGlobals(); }
  });
});
