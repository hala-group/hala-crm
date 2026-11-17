import { z } from 'zod';
import { objectIdSchema } from './schemas/identity.js';

const base = z.object({
  accountId: objectIdSchema,
  conversationId: objectIdSchema.optional(),
  to: z.string().min(6).max(100).optional(),
  clientMessageId: z.uuid(),
  replyToMessageId: objectIdSchema.optional(),
  mentions: z.array(z.string().min(1)).max(100).optional()
});
const media = z.object({ mediaId: objectIdSchema });
export const outgoingMessageSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('text'), text: z.string().min(1).max(4096), linkPreview: z.boolean().default(true) }),
  base.extend({ type: z.literal('image'), ...media.shape, caption: z.string().max(1024).optional(), viewOnce: z.boolean().optional() }),
  base.extend({ type: z.literal('video'), ...media.shape, caption: z.string().max(1024).optional(), gif: z.boolean().optional(), viewOnce: z.boolean().optional() }),
  base.extend({ type: z.literal('audio'), ...media.shape }),
  base.extend({ type: z.literal('voice'), ...media.shape }),
  base.extend({ type: z.literal('document'), ...media.shape, fileName: z.string().max(255).optional(), caption: z.string().max(1024).optional() }),
  base.extend({ type: z.literal('sticker'), ...media.shape }),
  base.extend({ type: z.literal('location'), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), name: z.string().max(200).optional(), address: z.string().max(500).optional() }),
  base.extend({ type: z.literal('contacts'), contacts: z.array(z.object({ name: z.string().min(1), phones: z.array(z.string()).min(1), vcard: z.string().optional() })).min(1).max(20) }),
  base.extend({ type: z.literal('reaction'), targetMessageId: objectIdSchema, emoji: z.string().max(8) }),
  base.extend({ type: z.literal('poll'), question: z.string().min(1).max(500), options: z.array(z.string().min(1).max(100)).min(2).max(12), selectableCount: z.number().int().min(0).max(12).default(1) }),
  base.extend({ type: z.literal('template'), name: z.string().min(1), language: z.string().min(2), components: z.unknown() }),
  base.extend({ type: z.literal('interactive'), kind: z.enum(['buttons', 'list']), body: z.string().min(1), data: z.unknown().optional() })
]).refine(value => Boolean(value.conversationId || value.to), { message: 'conversationId or to is required' });
export type OutgoingMessageInput = z.infer<typeof outgoingMessageSchema>;
export type ComposerMessageInput = OutgoingMessageInput extends infer T
  ? T extends OutgoingMessageInput ? Omit<T, 'accountId' | 'conversationId' | 'clientMessageId'> : never : never;

export const editMessageSchema = z.object({ text: z.string().min(1).max(4096) });
export const forwardMessageSchema = z.object({ conversationIds: z.array(objectIdSchema).min(1).max(20) });
export const deleteMessageQuerySchema = z.object({ scope: z.enum(['everyone', 'me']) });
export const uploadMediaSchema = z.object({ accountId: objectIdSchema, kind: z.enum(['image', 'video', 'audio', 'voice', 'document', 'sticker']) });
export const typingSchema = z.object({ conversationId: objectIdSchema });

export type OutboundOperation = 'send' | 'edit' | 'revoke' | 'forward' | 'read';
export interface OutboundCommand {
  type: 'outbound'; tenantId: string; accountId: string; messageId: string;
  operation: OutboundOperation; sourceMessageId?: string;
}
