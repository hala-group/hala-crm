import { z } from 'zod';
import { objectIdSchema } from './schemas/identity.js';

export const messageTypeSchema = z.enum([
  'text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',
  'contacts', 'reaction', 'poll', 'poll_vote', 'template', 'interactive', 'system', 'unknown'
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const mediaSourceSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
  mimeType: z.string().min(3),
  fileName: z.string().optional(),
  size: z.number().nonnegative().optional(),
  width: z.number().optional(), height: z.number().optional(), durationSec: z.number().optional(),
  mediaKeyBase64: z.string().min(1).optional(), cloudMediaId: z.string().min(1).optional(),
  cloudAccountId: objectIdSchema.optional(), cloudTenantId: objectIdSchema.optional(),
  directPath: z.string().optional(), url: z.string().optional()
});
export type MediaSource = z.infer<typeof mediaSourceSchema>;

export const interactiveMessageSchema = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().max(1024).optional(),
  body: z.string().max(4096).optional(),
  footer: z.string().max(1024).optional(),
  buttonText: z.string().max(256).optional(),
  selectedId: z.string().max(512).optional(),
  selectedTitle: z.string().max(1024).optional(),
  description: z.string().max(2048).optional(),
  responseJson: z.string().max(8192).optional()
});
export type InteractiveMessage = z.infer<typeof interactiveMessageSchema>;

export const templateMessageSchema = z.object({
  name: z.string().max(512).optional(),
  language: z.string().max(64).optional(),
  body: z.string().max(4096).optional(),
  componentsJson: z.string().max(8192).optional(),
  selectedId: z.string().max(512).optional(),
  selectedTitle: z.string().max(1024).optional()
});
export type TemplateMessage = z.infer<typeof templateMessageSchema>;

export const pollVoteSchema = z.object({
  targetWaMessageId: z.string().min(1),
  selectedOptions: z.array(z.string().max(100)).max(12).optional(),
  selectedOptionHashes: z.array(z.string().min(1)).max(12).optional(),
  encryptedPayloadBase64: z.string().max(16384).optional(),
  encryptedIvBase64: z.string().max(256).optional()
});
export type PollVote = z.infer<typeof pollVoteSchema>;

export const messageMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), targetWaMessageId: z.string().min(1), text: z.string().max(4096) }),
  z.object({ kind: z.literal('revoke'), targetWaMessageId: z.string().min(1) })
]);
export type MessageMutation = z.infer<typeof messageMutationSchema>;

export const normalizedInboundSchema = z.object({
  tenantId: objectIdSchema, accountId: objectIdSchema,
  waMessageId: z.string().min(1),
  waId: z.string().min(1), lid: z.string().optional(), phoneE164: z.string().optional(),
  pushName: z.string().optional(), isGroup: z.boolean().default(false), isSelf: z.boolean().optional(),
  sender: z.object({ waId: z.string().min(1), name: z.string().optional(), phoneE164: z.string().optional() }).optional(),
  direction: z.enum(['in', 'out']), type: messageTypeSchema,
  history: z.boolean().optional(),
  timestamp: z.coerce.date(),
  text: z.string().optional(), caption: z.string().optional(),
  location: z.object({ lat: z.number(), lng: z.number(), name: z.string().optional(), address: z.string().optional() }).optional(),
  contacts: z.array(z.object({ name: z.string(), phones: z.array(z.string()), vcard: z.string().optional() })).optional(),
  poll: z.object({ question: z.string(), options: z.array(z.object({ id: z.string(), text: z.string() })), selectableCount: z.number() }).optional(),
  pollVote: pollVoteSchema.optional(), interactive: interactiveMessageSchema.optional(), template: templateMessageSchema.optional(),
  reaction: z.object({ targetWaMessageId: z.string(), emoji: z.string() }).optional(),
  mutation: messageMutationSchema.optional(),
  quotedWaMessageId: z.string().optional(), mentions: z.array(z.string()).optional(), forwarded: z.boolean().optional(),
  raw: z.object({
    remoteJid: z.string().optional(),
    participant: z.string().optional(),
    messageType: z.string().optional(),
    protocolType: z.union([z.number(), z.string()]).optional(),
    stubType: z.number().optional()
  }).optional(),
  mediaSource: mediaSourceSchema.optional()
});
export type NormalizedInboundMessage = z.infer<typeof normalizedInboundSchema>;

export const inboxListQuerySchema = z.object({
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().max(100).optional(), accountId: objectIdSchema.optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).optional(), status: z.enum(['open', 'archived']).optional(),
  unreadOnly: z.preprocess(val => val === 'true' || val === true, z.boolean()).optional(),
  tag: z.string().max(50).optional()
});
export const messageListQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export interface MessageView {
  _id: string; tenantId: string; accountId: string; conversationId: string; contactId: string;
  waMessageId: string; direction: 'in' | 'out'; type: MessageType; timestamp: string;
  clientMessageId?: string; failureReason?: string;
  sender?: { contactId: string; name?: string; waId: string; phoneE164?: string };
  editedAt?: string; revokedAt?: string;
  text?: string; caption?: string; mediaId?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  contacts?: { name: string; phones: string[]; vcard?: string }[];
  poll?: { question: string; options: { id: string; text: string }[]; selectableCount: number };
  pollVote?: PollVote;
  interactive?: InteractiveMessage;
  template?: TemplateMessage;
  reaction?: { targetWaMessageId: string; emoji: string };
  quotedWaMessageId?: string; mentions?: string[]; forwarded?: boolean;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  mediaStatus?: 'pending' | 'uploading' | 'ready' | 'failed';
}

export interface ConversationView {
  _id: string; tenantId: string; accountId: string; contactId: string;
  contactName: string; contactWaId: string; status: 'open' | 'archived';
  contactPhoneE164?: string; contactAbout?: string | null;
  commonGroups?: { id: string; name: string }[];
  profileStatus?: 'pending' | 'ready' | 'unavailable' | 'failed'; profileCheckedAt?: string;
  assignedUserId?: string | null; lastMessageAt: string; lastMessagePreview: string;
  lastCallAt?: string;
  lastMessageType: MessageType; lastMessageDirection: 'in' | 'out';
  lastMessageStatus?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  unreadCount: number;
  tags?: string[];
}

export interface CallView {
  _id: string; accountId: string; contactId: string; direction: 'in' | 'out';
  isVideo: boolean; status: 'ringing' | 'missed' | 'rejected' | 'accepted' | 'ended';
  startedAt: string; endedAt?: string;
  contact?: {
    _id: string;
    displayName?: string;
    pushName?: string;
    phoneE164?: string;
    waId?: string;
    avatarUrl?: string;
  };
  account?: {
    _id: string;
    label: string;
    phoneNumber?: string;
    color?: string;
  };
  conversationId?: string;
}

export type DomainEvent =
  | { type: 'message.created'; tenantId: string; accountId: string; conversationId: string; assignedUserId?: string | null; message: MessageView }
  | { type: 'message.media_ready'; tenantId: string; accountId: string; conversationId: string; assignedUserId?: string | null; messageId: string; mediaId: string }
  | { type: 'message.status'; tenantId: string; accountId: string; conversationId: string; assignedUserId?: string | null; messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; failureReason?: string; waMessageId?: string }
  | { type: 'message.updated'; tenantId: string; accountId: string; conversationId: string; assignedUserId?: string | null; message: MessageView }
  | { type: 'typing'; tenantId: string; accountId: string; conversationId: string; assignedUserId?: string | null; userId: string; active: boolean }
  | { type: 'conversation.updated'; tenantId: string; accountId: string; conversation: ConversationView }
  | { type: 'conversation.assigned'; tenantId: string; accountId: string; conversationId: string; assignedUserId: string; eventId: string }
  | { type: 'call.incoming' | 'call.missed'; tenantId: string; accountId: string; callId: string; waCallId: string; contactId: string; isVideo: boolean };
