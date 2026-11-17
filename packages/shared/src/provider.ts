import { type NormalizedInboundMessage } from './inbound.js';
import { type OutgoingMessageInput, type OutboundCommand } from './outgoing.js';

export type ProviderCapability =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'
  | 'location' | 'contacts' | 'reaction' | 'poll' | 'reply' | 'mentions'
  | 'edit' | 'revoke' | 'forward' | 'template' | 'interactive';

export const BAILEYS_CAPABILITIES: readonly ProviderCapability[] = [
  'text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',
  'contacts', 'reaction', 'poll', 'reply', 'mentions', 'edit', 'revoke', 'forward'
];
export const CLOUD_API_CAPABILITIES: readonly ProviderCapability[] = [
  'text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',
  'contacts', 'reaction', 'reply', 'template', 'interactive'
];

export interface ProviderAccount { id: string; tenantId: string }
export interface ProviderContact {
  id: string; lid?: string; jid?: string; name?: string; notify?: string;
}
export interface HistorySyncTarget {
  jid: string;
  oldestMessageId: string;
  fromMe: boolean;
  timestampMs: number;
}
export type ProviderEvent =
  | { type: 'wa.qr'; accountId: string; tenantId: string; qr: string }
  | { type: 'wa.connection'; accountId: string; tenantId: string; status: 'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'error'; phoneNumber?: string; error?: string }
  | { type: 'wa.message.in'; accountId: string; tenantId: string; message: NormalizedInboundMessage }
  | { type: 'wa.contact'; accountId: string; tenantId: string; contact: ProviderContact }
  | { type: 'wa.chat.read_state'; accountId: string; tenantId: string; chatId: string; isUnread: boolean; unreadCount?: number }
  | { type: 'wa.message.status'; accountId: string; tenantId: string; waMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | ProviderCallEvent;
export interface ProviderCallEvent {
  type: 'wa.call'; tenantId: string; accountId: string; waCallId: string; waId: string;
  direction: 'in' | 'out'; isVideo: boolean;
  status: 'ringing' | 'missed' | 'rejected' | 'accepted' | 'ended'; startedAt: string;
}
export type SessionStatusEvent = Extract<ProviderEvent, { type: 'wa.qr' | 'wa.connection' }>;
export interface ProviderSession { close(): Promise<void> }
export interface ProviderMessageKey { jid: string; id: string; fromMe: boolean; participant?: string }
export interface ProviderSendRequest {
  jid: string; input: OutgoingMessageInput; messageId: string; media?: Uint8Array;
  quoted?: ProviderMessageKey; target?: ProviderMessageKey; forwarded?: boolean;
  quotedText?: string; mimeType?: string; fileName?: string;
}
export interface WhatsAppProvider {
  readonly name: 'baileys' | 'cloud_api' | 'fake';
  readonly capabilities: ReadonlySet<ProviderCapability>;
  open(account: ProviderAccount, fencingToken: number, emit: (event: ProviderEvent) => Promise<void>): Promise<ProviderSession>;
  syncHistory?(account: ProviderAccount, targets: HistorySyncTarget[]): Promise<number>;
  downloadMedia?(account: ProviderAccount, message: NormalizedInboundMessage): Promise<Buffer>;
  fetchProfilePicture?(account: ProviderAccount, jid: string): Promise<Buffer | null>;
  fetchContactDetails?(account: ProviderAccount, jids: string[]): Promise<{ about: string | null; commonGroups: { id: string; name: string }[]; subject?: string | null } | null>;
  logout(account: ProviderAccount): Promise<void>;
  send?(account: ProviderAccount, request: ProviderSendRequest): Promise<string>;
  edit?(account: ProviderAccount, jid: string, key: ProviderMessageKey, text: string): Promise<void>;
  revoke?(account: ProviderAccount, jid: string, key: ProviderMessageKey): Promise<void>;
  markRead?(account: ProviderAccount, keys: ProviderMessageKey[]): Promise<void>;
}

export interface AccountCommand {
  type: 'disconnect' | 'logout';
  accountId: string;
  tenantId: string;
}
export interface HistorySyncCommand { type: 'sync_history'; accountId: string; tenantId: string }
export interface RefreshAvatarCommand { type: 'refresh_avatar'; accountId: string; tenantId: string; contactId: string }
export interface RefreshProfileCommand { type: 'refresh_profile'; accountId: string; tenantId: string; contactId: string }
export type WorkerCommand = AccountCommand | HistorySyncCommand | RefreshAvatarCommand | RefreshProfileCommand | OutboundCommand;

export interface AccessChangedEvent { type: 'access.changed'; tenantId: string; userId: string; accountId: string }
export interface AccountDeletedEvent { type: 'account.deleted'; tenantId: string; accountId: string }
