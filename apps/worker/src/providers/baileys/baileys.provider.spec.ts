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

it('imports different chats concurrently while preserving each chat message order', async () => {
  const account = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() };
  const auth = { load: vi.fn().mockResolvedValue({ state: { creds: initAuthCreds(), keys: { get: vi.fn(), set: vi.fn() } },
    saveCreds: vi.fn() }) };
  const provider = new BaileysProvider(auth as unknown as EncryptedAuthStateStore);
  const ev = new EventEmitter();
  vi.mocked(makeWASocket).mockReturnValueOnce({ ev, end: vi.fn() } as unknown as WASocket);
  const processed: string[] = [];
  let releaseFirst = () => {};
  const firstMessage = new Promise<void>(resolve => { releaseFirst = resolve; });
  const emit = vi.fn(async (event: ProviderEvent) => {
    if (event.type !== 'wa.message.in') return;
    processed.push(event.message.waMessageId);
    if (event.message.waMessageId === 'first-message') await firstMessage;
  });
  const session = await provider.open(account, 1, emit);
  try {
    ev.emit('messaging-history.set', { chats: [], contacts: [],
      syncType: proto.HistorySync.HistorySyncType.FULL, messages: [
        { key: { id: 'first-message', remoteJid: '201111111111@s.whatsapp.net' }, message: { conversation: 'First' } },
        { key: { id: 'second-message', remoteJid: '201111111111@s.whatsapp.net' }, message: { conversation: 'Second' } },
        { key: { id: 'other-chat-message', remoteJid: '202222222222@s.whatsapp.net' }, message: { conversation: 'Other chat' } }
      ] });
    await vi.waitFor(() => expect(processed).toContain('other-chat-message'));
    expect(processed).toEqual(['first-message', 'other-chat-message']);
    releaseFirst();
    await vi.waitFor(() => expect(processed).toContain('second-message'));
    expect(processed.indexOf('first-message')).toBeLessThan(processed.indexOf('second-message'));
  } finally {
    releaseFirst();
    await session.close();
  }
});

it('replays recently accepted history notifications one batch at a time', async () => {
  const account = { id: new Types.ObjectId().toString(), tenantId: new Types.ObjectId().toString() };
  const creds = initAuthCreds();
  const acceptedIds = ['first-notification', 'second-notification'];
  creds.processedHistoryMessages = acceptedIds.map(id => ({ key: { id }, messageTimestamp: 1_700_000_000 }));
  const auth = { load: vi.fn().mockResolvedValue({ state: { creds, keys: { get: vi.fn(), set: vi.fn() } },
    saveCreds: vi.fn() }) };
  const syncType = proto.HistorySync.HistorySyncType.FULL;
  const notification = (id: string, text: string) => {
    const inline = deflateSync(proto.HistorySync.encode({ syncType,
      conversations: [{ id: '201234567890@s.whatsapp.net', messages: [
        { message: { key: { id }, message: { conversation: text } } }
      ] }]
    }).finish());
    return { raw: JSON.stringify({ protocolMessage: { historySyncNotification: { syncType,
      initialHistBootstrapInlinePayload: inline } } }, BufferJSON.replacer) };
  };
  const accountLookup = vi.fn().mockResolvedValue({ _id: new Types.ObjectId(account.id) });
  const readSecondNotification = vi.fn();
  const find = vi.fn().mockReturnValue({ *sort() {
    yield notification('first-history-message', 'Recovered first');
    readSecondNotification();
    yield notification('second-history-message', 'Recovered second');
  } });
  const connection = { db: { collection: (name: string) => name === 'whatsapp_accounts'
    ? { findOne: accountLookup } : { find, updateOne: vi.fn() } } } as unknown as Connection;
  const provider = new BaileysProvider(auth as unknown as EncryptedAuthStateStore, connection);
  vi.mocked(makeWASocket).mockReturnValueOnce({ ev: new EventEmitter(), end: vi.fn() } as unknown as WASocket);
  let allowFirstWrite = () => {};
  const firstWrite = new Promise<void>(resolve => { allowFirstWrite = resolve; });
  const emit = vi.fn(async (event: ProviderEvent) => {
    if (event.type === 'wa.message.in' && event.message.waMessageId === 'first-history-message') await firstWrite;
  });
  const session = await provider.open(account, 1, emit);
  const syncing = provider.syncHistory(account, []);
  try {
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'wa.message.in',
      message: expect.objectContaining({ waMessageId: 'first-history-message', text: 'Recovered first', history: true }) })));
    expect(readSecondNotification).not.toHaveBeenCalled();
    allowFirstWrite();
    await syncing;
    expect(accountLookup).toHaveBeenCalledWith({ _id: new Types.ObjectId(account.id), tenantId: new Types.ObjectId(account.tenantId) },
      { projection: { _id: 1 } });
    expect(find).toHaveBeenCalledWith({ accountId: new Types.ObjectId(account.id),
      id: { $in: acceptedIds }, createdAt: { $gte: expect.any(Date) } }, { projection: { raw: 1 } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'wa.message.in',
      message: expect.objectContaining({ waMessageId: 'second-history-message', text: 'Recovered second', history: true }) }));
  } finally {
    allowFirstWrite();
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
