import { type proto } from '@whiskeysockets/baileys';
import { type ProviderContact } from '@hala/shared';

type ChatIdentity = Partial<Pick<proto.IConversation, 'id' | 'lidJid' | 'pnJid' | 'name'>>;

export function contactFromChat(chat: ChatIdentity): ProviderContact | null {
  const id = chat.id?.trim();
  if (!id || (!id.endsWith('@lid') && !id.endsWith('@s.whatsapp.net') && !id.endsWith('@g.us'))) return null;
  if (id.endsWith('@g.us')) {
    return { id, name: chat.name ?? undefined };
  }
  const lid = chat.lidJid?.endsWith('@lid') ? chat.lidJid : id.endsWith('@lid') ? id : undefined;
  const jid = chat.pnJid?.endsWith('@s.whatsapp.net') ? chat.pnJid
    : id.endsWith('@s.whatsapp.net') ? id : undefined;
  return { id, lid, jid, name: chat.name ?? undefined };
}

export function chatReadStateFromUpdate(chat: Partial<Pick<proto.IConversation, 'id' | 'unreadCount'>>):
  { chatId: string; isUnread: boolean; unreadCount?: number } | null {
  if (!chat.id || chat.unreadCount === undefined || chat.unreadCount === null) return null;
  const isUnread = chat.unreadCount === -1 || chat.unreadCount > 0;
  const unreadCount = chat.unreadCount > 0 ? chat.unreadCount : chat.unreadCount === -1 ? 1 : 0;
  return { chatId: chat.id, isUnread, unreadCount };
}

export function contactsFromHistoryMappings(mappings: readonly proto.IPhoneNumberToLIDMapping[]): ProviderContact[] {
  return mappings.flatMap(mapping => {
    const lid = mapping.lidJid;
    const jid = mapping.pnJid;
    return lid?.endsWith('@lid') && jid?.endsWith('@s.whatsapp.net')
      ? [{ id: lid, lid, jid }] : [];
  });
}
