import { Schema, Types } from 'mongoose';
import { type InteractiveMessage, type MessageType, type OutgoingMessageInput, type PollVote, type TemplateMessage } from '@hala/shared';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface ContactRecord {
  tenantId: Types.ObjectId; waId: string; lid?: string; phoneE164?: string;
  displayName?: string; pushName?: string; avatarUrl?: string; isGroup: boolean;
  tags: string[]; customFields: Record<string, unknown>; ownerUserId?: Types.ObjectId; lifecycleStage?: string;
  createdAt: Date; updatedAt: Date;
}
export interface ConversationRecord {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; contactId: Types.ObjectId;
  status: 'open' | 'archived'; assignedUserId?: Types.ObjectId | null;
  lastMessageAt: Date; lastMessagePreview: string; lastMessageType: MessageType;
  lastCallAt?: Date;
  lastMessageDirection: 'in' | 'out';
  lastMessageStatus?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  unreadCount: number;
  contactAbout?: string | null; commonGroups?: { id: string; name: string }[];
  profileStatus?: 'pending' | 'ready' | 'unavailable' | 'failed'; profileCheckedAt?: Date;
  createdAt: Date; updatedAt: Date;
}
export interface MessageRecord {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; conversationId: Types.ObjectId; contactId: Types.ObjectId;
  waMessageId: string; clientMessageId?: string; direction: 'in' | 'out'; type: MessageType;
  text?: string; caption?: string; mediaId?: Types.ObjectId;
  location?: { lat: number; lng: number; name?: string; address?: string };
  contacts?: { name: string; phones: string[]; vcard?: string }[];
  poll?: { question: string; options: { id: string; text: string }[]; selectableCount: number };
  pollVote?: PollVote; interactive?: InteractiveMessage; template?: TemplateMessage;
  reaction?: { targetWaMessageId: string; emoji: string };
  quotedWaMessageId?: string; mentions?: string[]; forwarded?: boolean;
  editedAt?: Date; revokedAt?: Date; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  failureReason?: string; statusHistory: { status: string; at: Date }[];
  sentByUserId?: Types.ObjectId; timestamp: Date;
  outbound?: OutgoingMessageInput;
  pendingEditText?: string; hiddenForUserIds?: Types.ObjectId[];
  raw?: { messageType?: string; protocolType?: number; stubType?: number };
  createdAt: Date; updatedAt: Date;
}
export interface MediaRecord {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; messageId?: Types.ObjectId;
  mimeType: string; size?: number; fileName?: string; storageKey: string; storageDriver: 'local' | 's3' | 'hostinger';
  sha256?: string; width?: number; height?: number; durationSec?: number; thumbnailKey?: string;
  status: 'uploading' | 'pending' | 'ready' | 'failed';
  createdAt: Date; updatedAt: Date;
}
export interface ContactAvatarRecord {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; contactId: Types.ObjectId;
  status: 'pending' | 'ready' | 'unavailable' | 'failed'; checkedAt: Date;
  storageKey?: string; storageDriver?: 'local' | 's3' | 'hostinger'; mimeType?: string;
  createdAt: Date; updatedAt: Date;
}

export const contactSchema = new Schema<ContactRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  waId: { type: String, required: true }, lid: String, phoneE164: String,
  displayName: String, pushName: String, avatarUrl: String,
  isGroup: { type: Boolean, default: false },
  tags: { type: [String], default: [] }, customFields: { type: Schema.Types.Mixed, default: {} },
  ownerUserId: Schema.Types.ObjectId, lifecycleStage: String
}, { collection: 'contacts', timestamps: true });
contactSchema.index({ tenantId: 1, waId: 1 }, { unique: true });
contactSchema.index({ tenantId: 1, lid: 1 }, { unique: true, partialFilterExpression: { lid: { $type: 'string' } } });
contactSchema.index({ tenantId: 1, phoneE164: 1 }, { partialFilterExpression: { phoneE164: { $type: 'string' } } });
contactSchema.index({ tenantId: 1, tags: 1 });
contactSchema.plugin(tenantPlugin);

export const conversationSchema = new Schema<ConversationRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['open', 'archived'], default: 'open' },
  assignedUserId: Schema.Types.ObjectId, lastMessageAt: { type: Date, required: true },
  lastMessagePreview: { type: String, default: '' }, lastMessageType: { type: String, required: true },
  lastCallAt: Date,
  lastMessageDirection: { type: String, enum: ['in', 'out'], required: true },
  lastMessageStatus: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'] },
  unreadCount: { type: Number, default: 0 },
  contactAbout: String, commonGroups: [{ _id: false, id: String, name: String }],
  profileStatus: { type: String, enum: ['pending', 'ready', 'unavailable', 'failed'] }, profileCheckedAt: Date
}, { collection: 'conversations', timestamps: true });
conversationSchema.index({ tenantId: 1, accountId: 1, contactId: 1 }, { unique: true });
conversationSchema.index({ tenantId: 1, accountId: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, assignedUserId: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, accountId: 1, lastCallAt: -1 });
conversationSchema.plugin(tenantPlugin);

export const messageSchema = new Schema<MessageRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  conversationId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  waMessageId: { type: String, required: true }, clientMessageId: String,
  direction: { type: String, enum: ['in', 'out'], required: true },
  type: { type: String, required: true }, text: String, caption: String,
  mediaId: Schema.Types.ObjectId,
  location: { lat: Number, lng: Number, name: String, address: String },
  contacts: [{ name: String, phones: [String], vcard: String }],
  poll: { type: new Schema({ question: String, options: [{ id: String, text: String }], selectableCount: Number }, { _id: false }), default: undefined },
  pollVote: {
    type: new Schema({
      targetWaMessageId: String, selectedOptions: [String], selectedOptionHashes: [String],
      encryptedPayloadBase64: String, encryptedIvBase64: String
    }, { _id: false }), default: undefined
  },
  interactive: {
    kind: String, title: String, body: String, footer: String, buttonText: String,
    selectedId: String, selectedTitle: String, description: String, responseJson: String
  },
  template: { name: String, language: String, body: String, componentsJson: String, selectedId: String, selectedTitle: String },
  reaction: { targetWaMessageId: String, emoji: String },
  quotedWaMessageId: String, mentions: [String], forwarded: Boolean,
  editedAt: Date, revokedAt: Date,
  status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'], required: true },
  failureReason: String,
  statusHistory: [{ status: String, at: Date }],
  sentByUserId: Schema.Types.ObjectId, timestamp: { type: Date, required: true },
  outbound: Schema.Types.Mixed,
  pendingEditText: String, hiddenForUserIds: [Schema.Types.ObjectId],
  raw: { remoteJid: String, messageType: String, protocolType: Number, stubType: Number }
}, { collection: 'messages', timestamps: true });
messageSchema.index({ tenantId: 1, accountId: 1, waMessageId: 1 }, { unique: true });
messageSchema.index({ tenantId: 1, accountId: 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } });
messageSchema.index({ conversationId: 1, timestamp: -1, _id: -1 });
messageSchema.index({ text: 'text', caption: 'text' });
messageSchema.plugin(tenantPlugin);

export const contactAvatarSchema = new Schema<ContactAvatarRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['pending', 'ready', 'unavailable', 'failed'], required: true },
  checkedAt: { type: Date, required: true }, storageKey: String,
  storageDriver: { type: String, enum: ['local', 's3', 'hostinger'] }, mimeType: String
}, { collection: 'contact_avatars', timestamps: true });
contactAvatarSchema.index({ tenantId: 1, accountId: 1, contactId: 1 }, { unique: true });
contactAvatarSchema.plugin(tenantPlugin);

export const mediaSchema = new Schema<MediaRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  messageId: Schema.Types.ObjectId,
  mimeType: { type: String, required: true }, size: Number, fileName: String,
  storageKey: { type: String, required: true }, storageDriver: { type: String, enum: ['local', 's3', 'hostinger'], required: true },
  sha256: String, width: Number, height: Number, durationSec: Number, thumbnailKey: String,
  status: { type: String, enum: ['uploading', 'pending', 'ready', 'failed'], required: true }
}, { collection: 'media', timestamps: true });
mediaSchema.index({ tenantId: 1, accountId: 1, messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: 'objectId' } } });
mediaSchema.plugin(tenantPlugin);
