import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { downloadContentFromMessage, proto, type BaileysEventMap, type WASocket, type WAMessageKey } from '@whiskeysockets/baileys';
import { type HistorySyncTarget } from '@hala/shared';
import { describe, expect, it, vi } from 'vitest';
import { downloadHistoryBatch, pageHistory } from './history.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('@whiskeysockets/baileys', async importOriginal => ({
  ...await importOriginal<typeof import('@whiskeysockets/baileys')>(),
  downloadContentFromMessage: vi.fn()
}));

describe('WhatsApp history import', () => {
  it('decodes inline bootstrap conversations and recovers missing message addresses', async () => {
    const jid = '201234567890@s.whatsapp.net';
    const timestamp = 1_700_000_000;
    const payload = proto.HistorySync.encode({
      syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
      conversations: [{ id: jid, conversationTimestamp: timestamp, messages: [
        { message: { key: { id: 'no-address' }, message: { conversation: 'Older' }, messageTimestamp: timestamp } },
        { message: { key: { remoteJid: jid, id: 'addressed' }, message: { conversation: 'Newest' }, messageTimestamp: timestamp } }
      ] }]
    }).finish();
    const history = await downloadHistoryBatch({ initialHistBootstrapInlinePayload: deflateSync(payload) }, new AbortController().signal);
    expect(history.chats).toHaveLength(1);
    expect(history.messages.map(message => message.key)).toEqual([
      { id: 'no-address', remoteJid: jid },
      expect.objectContaining({ id: 'addressed', remoteJid: jid })
    ]);
  });

  it('imports a downloaded batch with its existing addresses, missing addresses and phone mappings', async () => {
    const lid = '123456789@lid';
    const jid = '201234567890@s.whatsapp.net';
    const payload = proto.HistorySync.encode({
      syncType: proto.HistorySync.HistorySyncType.FULL,
      conversations: [{ id: lid, messages: [
        { message: { key: { id: 'missing-address' } } },
        { message: { key: { id: 'native-event', remoteJid: lid } } }
      ] }],
      phoneNumberToLidMappings: [{ lidJid: lid, pnJid: jid }]
    }).finish();
    const stream = new PassThrough();
    vi.mocked(downloadContentFromMessage).mockResolvedValueOnce(stream);
    stream.end(deflateSync(payload));
    const history = await downloadHistoryBatch({ directPath: '/history', mediaKey: new Uint8Array(32) }, new AbortController().signal);
    expect(history.chats).toHaveLength(1);
    expect(history.messages.map(message => message.key)).toEqual([
      { remoteJid: lid, id: 'missing-address' }, { remoteJid: lid, id: 'native-event' }
    ]);
    expect(history.contacts).toEqual([{ id: lid, lid, jid }]);
  });

  it('releases a stalled decrypting stream when the history request is canceled', async () => {
    const stream = new PassThrough();
    vi.mocked(downloadContentFromMessage).mockResolvedValueOnce(stream);
    const controller = new AbortController();
    const download = downloadHistoryBatch({ directPath: '/history', mediaKey: new Uint8Array(32) }, controller.signal);
    const failure = expect(download).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await failure;
    expect(stream.destroyed).toBe(true);
  });

  it('requests every chat and continues from the older WhatsApp key until the phone sends no older record', async () => {
    const ev = new EventEmitter();
    const targets: HistorySyncTarget[] = Array.from({ length: 21 }, (_, index) => ({
      jid: `${201234567890 + index}@s.whatsapp.net`,
      oldestMessageId: `known-${index}`, fromMe: false, timestampMs: 1_700_000_000_000
    }));
    const fetchMessageHistory = vi.fn(async (_count: number, key: WAMessageKey, timestampMs: number) => {
      const requestId = `request-${key.id}`;
      const olderMessage = { key: { id: 'older', fromMe: true },
        messageTimestamp: timestampMs / 1000 - 1 };
      const page: BaileysEventMap['messaging-history.set'] = { chats: key.remoteJid ? [{ id: key.remoteJid }] : [], contacts: [],
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND, peerDataRequestSessionId: requestId,
        messages: key.id === 'known-0' ? [olderMessage] : [] };
      ev.emit('messaging-history.set', page);
      return requestId;
    });
    const failure = vi.fn();
    const job = pageHistory({ ev, fetchMessageHistory } as unknown as WASocket, targets, new AbortController().signal, failure);
    await expect(job).resolves.toBe(22);
    expect(fetchMessageHistory.mock.calls.slice(0, 21).map(([, key]) => key.id))
      .toEqual(targets.map(target => target.oldestMessageId));
    expect(fetchMessageHistory).toHaveBeenLastCalledWith(50,
      { id: 'older', fromMe: true, remoteJid: targets[0]?.jid }, 1_699_999_999_000);
    expect(failure).not.toHaveBeenCalled();
    expect(ev.listenerCount('messaging-history.set')).toBe(0);
  });
});
