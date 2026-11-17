import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { type AnyMessageContent, type WASocket } from '@whiskeysockets/baileys';
import { type OutgoingMessageInput, type ProviderSendRequest } from '@hala/shared';
import { type EncryptedAuthStateStore } from './auth-state.store.js';
import { BaileysProvider } from './baileys.provider.js';

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
