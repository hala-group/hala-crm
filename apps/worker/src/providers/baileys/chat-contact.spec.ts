import { describe, expect, it } from 'vitest';
import { chatReadStateFromUpdate, contactFromChat, contactsFromHistoryMappings } from './chat-contact.js';

describe('Baileys chat contact identity', () => {
  it('extracts the actual phone from a LID history conversation', () => {
    expect(contactFromChat({ id: '12345@lid', pnJid: '201001234567@s.whatsapp.net', name: 'Ali' }))
      .toEqual({ id: '12345@lid', lid: '12345@lid', jid: '201001234567@s.whatsapp.net', name: 'Ali' });
  });

  it('keeps the LID unknown when WhatsApp supplies no phone mapping', () => {
    expect(contactFromChat({ id: '12345@lid' }))
      .toEqual({ id: '12345@lid', lid: '12345@lid', jid: undefined, name: undefined });
  });

  it('uses the PN as primary identity when the chat includes a LID', () => {
    expect(contactFromChat({ id: '201001234567@s.whatsapp.net', lidJid: '12345@lid' }))
      .toMatchObject({ lid: '12345@lid', jid: '201001234567@s.whatsapp.net' });
  });

  it('extracts group identity and subject name from group chats', () => {
    expect(contactFromChat({ id: '12345-67890@g.us', name: 'فريق العمل' }))
      .toEqual({ id: '12345-67890@g.us', name: 'فريق العمل' });
  });

  it('extracts phone mappings from the raw history sync payload', () => {
    expect(contactsFromHistoryMappings([
      { lidJid: '12345@lid', pnJid: '201001234567@s.whatsapp.net' },
      { lidJid: '67890@lid', pnJid: null }
    ])).toEqual([{ id: '12345@lid', lid: '12345@lid', jid: '201001234567@s.whatsapp.net' }]);
  });

  it('forwards explicit read and unread updates including message unread counts', () => {
    expect(chatReadStateFromUpdate({ id: '201001234567@s.whatsapp.net', unreadCount: 0 }))
      .toEqual({ chatId: '201001234567@s.whatsapp.net', isUnread: false, unreadCount: 0 });
    expect(chatReadStateFromUpdate({ id: '201001234567@s.whatsapp.net', unreadCount: -1 }))
      .toEqual({ chatId: '201001234567@s.whatsapp.net', isUnread: true, unreadCount: 1 });
    expect(chatReadStateFromUpdate({ id: '201001234567@s.whatsapp.net', unreadCount: 3 }))
      .toEqual({ chatId: '201001234567@s.whatsapp.net', isUnread: true, unreadCount: 3 });
    expect(chatReadStateFromUpdate({ id: '201001234567@s.whatsapp.net' })).toBeNull();
  });
});
