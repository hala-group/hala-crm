import { z } from 'zod';
import { objectIdSchema } from './identity.js';
import { type MessageView } from '../inbound.js';

export const assignConversationSchema = z.object({ userId: objectIdSchema.nullable() });

export const updateConversationTagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20)
});

export const archiveConversationSchema = z.object({
  archived: z.boolean()
});

export const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  accountId: objectIdSchema.optional(),
  conversationId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export interface MessageSearchResultView {
  message: MessageView;
  contactName: string;
  contactWaId: string;
  contactPhoneE164?: string;
}
