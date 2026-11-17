import { describe, expect, it } from 'vitest';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { normalizeBaileysMessage } from './normalize-message.js';

const make = (message: WAMessage['message'], extras: Partial<WAMessage> = {}): WAMessage => ({
  key: { remoteJid: '201001234567@s.whatsapp.net', id: 'wa-id', fromMe: false },
  messageTimestamp: 1_700_000_000, message, pushName: 'Ali', ...extras
});

describe('Baileys inbound normalizer', () => {
  it.each([
    [{ conversation: 'hello' }, 'text'],
    [{ imageMessage: { mimetype: 'image/jpeg' } }, 'image'],
    [{ videoMessage: { mimetype: 'video/mp4' } }, 'video'],
    [{ audioMessage: { ptt: false } }, 'audio'],
    [{ audioMessage: { ptt: true } }, 'voice'],
    [{ documentMessage: { fileName: 'a.pdf' } }, 'document'],
    [{ stickerMessage: {} }, 'sticker'],
    [{ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }, 'location'],
    [{ contactMessage: { displayName: 'Bob', vcard: 'BEGIN:VCARD\nTEL:+12345\nEND:VCARD' } }, 'contacts'],
    [{ reactionMessage: { text: '👍', key: { id: 'target' } } }, 'reaction'],
    [{ pollCreationMessage: { name: 'Question', options: [{ optionName: 'Yes' }] } }, 'poll'],
    [{ pollUpdateMessage: { pollCreationMessageKey: { id: 'poll' } } }, 'poll_vote'],
    [{ templateMessage: {} }, 'template'],
    [{ interactiveMessage: {} }, 'interactive'],
    [{ protocolMessage: { type: 0 } }, 'system'],
    [{ senderKeyDistributionMessage: {} }, 'unknown']
  ] as const)('normalizes %s as %s', (content, type) => {
    const result = normalizeBaileysMessage('507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012', make(content));
    expect(result?.type).toBe(type);
    expect(result?.waId).toBe('201001234567@s.whatsapp.net');
    expect(result?.phoneE164).toBe('+201001234567');
  });

  it('preserves outgoing echo, LID and reply metadata', () => {
    const result = normalizeBaileysMessage('a', 'b', make({ extendedTextMessage: {
      text: 'reply', contextInfo: { stanzaId: 'quoted', mentionedJid: ['201002222222@s.whatsapp.net'], isForwarded: true }
    } }, { key: { remoteJid: '12345@lid', senderPn: '201001234567@s.whatsapp.net', id: 'echo', fromMe: true } }));
    expect(result).toMatchObject({ direction: 'out', waId: '12345@lid', lid: '12345@lid',
      quotedWaMessageId: 'quoted', forwarded: true });
    expect(result?.phoneE164).toBeUndefined();
  });

  it('ignores WhatsApp status broadcasts instead of normalizing them as chats', () => {
    const result = normalizeBaileysMessage('a', 'b', make({ conversation: 'story update' }, {
      key: { remoteJid: 'status@broadcast', id: 'status-1', fromMe: false }
    }));
    expect(result).toBeNull();
  });

  it('ignores placeholders that have no message content', () => {
    expect(normalizeBaileysMessage('a', 'b', make({ placeholderMessage: {} }))).toBeNull();
  });

  it('ignores ciphertext placeholders that Baileys could not decrypt', () => {
    for (const messageStubType of [proto.WebMessageInfo.StubType.CIPHERTEXT,
      proto.WebMessageInfo.StubType.E2E_ENCRYPTED, proto.WebMessageInfo.StubType.E2E_ENCRYPTED_NOW]) {
      expect(normalizeBaileysMessage('a', 'b', make(undefined, { messageStubType }))).toBeNull();
    }
  });

  it('does not mistake a null stub on unsupported content for a system event', () => {
    const result = normalizeBaileysMessage('a', 'b', make({ albumMessage: {} }, { messageStubType: null }));
    expect(result?.type).toBe('unknown');
    expect(normalizeBaileysMessage('a', 'b', make(undefined,
      { messageStubType: proto.WebMessageInfo.StubType.BIZ_COEX_PRIVACY_INIT }))?.type).toBe('system');
  });

  it('classifies media despite Baileys supplying a null conversation field', () => {
    for (const [content, type] of [
      [{ conversation: null, imageMessage: { mimetype: 'image/jpeg' } }, 'image'],
      [{ conversation: null, documentMessage: { mimetype: 'application/pdf' } }, 'document'],
      [{ conversation: null, audioMessage: { mimetype: 'audio/ogg' } }, 'audio']
    ] as const) {
      expect(normalizeBaileysMessage('a', 'b', make(content))?.type).toBe(type);
    }
  });

  it('preserves the original WhatsApp JID needed to request history for LID conversations', () => {
    const result = normalizeBaileysMessage('a', 'b', make({ conversation: 'hello' }, {
      key: { remoteJid: '12345@lid', senderPn: '201001234567@s.whatsapp.net', id: 'lid-message', fromMe: false }
    }));
    expect(result?.raw?.remoteJid).toBe('12345@lid');
    expect(result?.phoneE164).toBe('+201001234567');
  });

  it('preserves interactive selections and encrypted poll-vote payloads', () => {
    const selected = normalizeBaileysMessage('a', 'b', make({ buttonsResponseMessage: {
      selectedButtonId: 'confirm', selectedDisplayText: 'Confirm'
    } }));
    expect(selected).toMatchObject({ type: 'interactive', text: 'Confirm',
      interactive: { kind: 'button_reply', selectedId: 'confirm', selectedTitle: 'Confirm' } });

    const vote = normalizeBaileysMessage('a', 'b', make({ pollUpdateMessage: {
      pollCreationMessageKey: { id: 'poll-id' }, vote: { encPayload: Buffer.from([1, 2]), encIv: Buffer.from([3]) }
    } }));
    expect(vote).toMatchObject({ type: 'poll_vote', quotedWaMessageId: 'poll-id',
      pollVote: { targetWaMessageId: 'poll-id', encryptedPayloadBase64: 'AQI=', encryptedIvBase64: 'Aw==' } });
  });

  it('normalizes WhatsApp protocol edits and deletes as mutations of the original message', () => {
    const edited = normalizeBaileysMessage('a', 'b', make({ protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'original-id' },
      editedMessage: { conversation: 'Corrected text' }
    } }));
    expect(edited).toMatchObject({ type: 'system', mutation: { kind: 'edit', targetWaMessageId: 'original-id', text: 'Corrected text' } });

    const revoked = normalizeBaileysMessage('a', 'b', make({ protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'original-id' }
    } }));
    expect(revoked).toMatchObject({ type: 'system', mutation: { kind: 'revoke', targetWaMessageId: 'original-id' } });
  });
});
