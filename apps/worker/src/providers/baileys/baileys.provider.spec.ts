import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { type Connection, Types } from 'mongoose';
import makeWASocket, { BufferJSON, downloadContentFromMessage, initAuthCreds, proto, type AnyMessageContent, type WASocket } from '@whiskeysockets/baileys';
import { type OutgoingMessageInput, type ProviderEvent, type ProviderSendRequest } from '@hala/shared';
import { type EncryptedAuthStateStore } from './auth-state.store.js';
import { BaileysProvider } from './baileys.provider.js';

vi.mock('@whiskeysockets/baileys', async importOriginal => ({
  ...await importOriginal<typeof import('@whiskeysockets/baileys')>(),
  default: vi.fn(),
  downloadContentFromMessage: vi.fn()
}));

it('persists a decoded history event while the raw download is still open', async () => {
  const account = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() };
  const auth = { load: vi.fn().mockResolvedValue({ state: { creds: initAuthCreds(), keys: { get: vi.fn(), set: vi.fn() } },
    saveCreds: vi.fn() }) };
  const provider = new BaileysProvider(auth as unknown as EncryptedAuthStateStore);
  const ev = new EventEmitter();
  const stream = new PassThrough();
  vi.mocked(makeWASocket).mockReturnValueOnce({ ev, end: vi.fn() } as unknown as WASocket);
  vi.mocked(downloadContentFromMessage).mockResolvedValueOnce(stream);
  const emit = vi.fn(async (_event: ProviderEvent) => {});
  const session = await provider.open(account, 1, emit);
  try {
    const config = vi.mocked(makeWASocket).mock.lastCall?.[0];
    const syncType = proto.HistorySync.HistorySyncType.FULL;
    expect(config?.shouldSyncHistoryMessage?.({ mediaKey: new Uint8Array(32), directPath: '/test-history', syncType })).toBe(true);
    await vi.waitFor(() => expect(downloadContentFromMessage).toHaveBeenCalledOnce());
    ev.emit('messaging-history.set', { chats: [], contacts: [], syncType, messages: [{
      key: { id: 'decoded-history', remoteJid: '201234567890@s.whatsapp.net' }, message: { conversation: 'Saved' }
    }] });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'wa.message.in', message: expect.objectContaining({ waMessageId: 'decoded-history', history: true })
    })));
    expect(stream.destroyed).toBe(false);
  } finally {
    await session.close();
  }
});

it('replays only recently cached history notifications accepted by the linked session', async () => {
  const account = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() };
  const creds = initAuthCreds();
  creds.processedHistoryMessages = [{ key: { id: 'accepted-notification' }, messageTimestamp: 1_700_000_000 }];
  const auth = { load: vi.fn().mockResolvedValue({ state: { creds, keys: { get: vi.fn(), set: vi.fn() } },
    saveCreds: vi.fn() }) };
  const syncType = proto.HistorySync.HistorySyncType.FULL;
  const inline = deflateSync(proto.HistorySync.encode({ syncType,
    conversations: [{ id: '201234567890@s.whatsapp.net', messages: [
      { message: { key: { id: 'cached-history-message' }, message: { conversation: 'Recovered' } } }
    ] }]
  }).finish());
  const raw = JSON.stringify({ protocolMessage: { historySyncNotification: { syncType,
    initialHistBootstrapInlinePayload: inline } } }, BufferJSON.replacer);
  const accountLookup = vi.fn().mockResolvedValue({ _id: new Types.ObjectId(account.id) });
  const find = vi.fn().mockReturnValue({ sort: () => [{ raw }] });
  const connection = { db: { collection: (name: string) => name === 'whatsapp_accounts'
    ? { findOne: accountLookup } : { find, updateOne: vi.fn() } } } as unknown as Connection;
  const provider = new BaileysProvider(auth as unknown as EncryptedAuthStateStore, connection);
  vi.mocked(makeWASocket).mockReturnValueOnce({ ev: new EventEmitter(), end: vi.fn() } as unknown as WASocket);
  const emit = vi.fn(async (_event: ProviderEvent) => {});
  const session = await provider.open(account, 1, emit);
  try {
    await provider.syncHistory(account, []);
    expect(accountLookup).toHaveBeenCalledWith({ _id: new Types.ObjectId(account.id), tenantId: new Types.ObjectId(account.tenantId) },
      { projection: { _id: 1 } });
    expect(find).toHaveBeenCalledWith({ accountId: new Types.ObjectId(account.id),
      id: { $in: ['accepted-notification'] }, createdAt: { $gte: expect.any(Date) } }, { projection: { raw: 1 } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'wa.message.in',
      message: expect.objectContaining({ waMessageId: 'cached-history-message', text: 'Recovered', history: true }) }));
  } finally {
    await session.close();
  }
});

describe('BaileysProvider voice messages', () => {
  it('sends voice media as an Ogg/Opus push-to-talk message', async () => {
    const accountId = new Types.ObjectId().toString();
    const tenantId = new Types.ObjectId().toString();
    const input: OutgoingMessageInput = { type: 'voice', accountId, conversationId: new Types.ObjectId().toString(),
      clientMessageId: crypto.randomUUID(), mediaId: new Types.ObjectId().toString() };
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({ key: { id: 'wa-voice-id' } }));
    const provider = new BaileysProvider({} as EncryptedAuthStateStore);
    const socket = { sendMessage: sendMessage as unknown as WASocket['sendMessage'] } as unknown as WASocket;
    (provider as unknown as { sockets: Map<string, WASocket> }).sockets.set(accountId, socket);
    const request: ProviderSendRequest = { jid: '201234567890@s.whatsapp.net', input, messageId: 'local-voice-id',
      media: Buffer.from('OggS'), mimeType: 'audio/ogg' };

    await expect(provider.send({ id: accountId, tenantId }, request)).resolves.toBe('wa-voice-id');

    expect(sendMessage).toHaveBeenCalledOnce();
    const content = sendMessage.mock.calls[0]?.[1] as AnyMessageContent;
    expect(content).toMatchObject({ mimetype: 'audio/ogg; codecs=opus', ptt: true });
    expect(content).toHaveProperty('audio');
  });

  it('caches sent messages and returns them via getMessage for retry receipts', async () => {
    const accountId = new Types.ObjectId().toString();
    const tenantId = new Types.ObjectId().toString();
    const input: OutgoingMessageInput = { type: 'voice', accountId, conversationId: new Types.ObjectId().toString(),
      clientMessageId: crypto.randomUUID(), mediaId: new Types.ObjectId().toString() };
    const fakeMessage = { audioMessage: { url: 'https://wa.media/audio', mimetype: 'audio/ogg; codecs=opus', ptt: true } };
    const sendMessage = vi.fn(async () => ({ key: { id: '3EB0VOICE1234' }, message: fakeMessage }));
    const provider = new BaileysProvider({} as EncryptedAuthStateStore);
    const socket = { sendMessage: sendMessage as unknown as WASocket['sendMessage'] } as unknown as WASocket;
    (provider as unknown as { sockets: Map<string, WASocket> }).sockets.set(accountId, socket);

    const request: ProviderSendRequest = { jid: '201234567890@s.whatsapp.net', input, messageId: '3EB0VOICE1234',
      media: Buffer.from('OggS'), mimeType: 'audio/ogg' };

    const sentId = await provider.send({ id: accountId, tenantId }, request);
    expect(sentId).toBe('3EB0VOICE1234');

    const retrieved = await provider.getMessage(accountId, '3EB0VOICE1234');
    expect(retrieved).toEqual(fakeMessage);

    const missing = await provider.getMessage(accountId, 'non-existent');
    expect(missing).toBeUndefined();
  });
});
