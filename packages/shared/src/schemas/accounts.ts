import { z } from 'zod';
import { objectIdSchema } from './identity.js';

export const accountLevelSchema = z.enum(['view', 'reply', 'manage']);
export const accountStatusSchema = z.enum(['created', 'qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out', 'error']);
export const providerNameSchema = z.enum(['baileys', 'cloud_api']);
export const confirmClearChatsSchema = z.object({ confirm: z.literal(true) });
export const createAccountSchema = z.object({
  label: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  provider: providerNameSchema.default('baileys'),
  cloud: z.object({
    phoneNumberId: z.string().regex(/^\d{5,30}$/),
    wabaId: z.string().regex(/^\d{5,30}$/),
    accessToken: z.string().min(20)
  }).optional()
}).superRefine((value, context) => {
  if (value.provider === 'cloud_api' && !value.cloud) context.addIssue({ code: 'custom', message: 'Cloud API credentials are required', path: ['cloud'] });
  if (value.provider === 'baileys' && value.cloud) context.addIssue({ code: 'custom', message: 'Cloud API credentials require cloud_api provider', path: ['cloud'] });
});
export const updateAccountSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
});
export const setAccountMemberSchema = z.object({ level: accountLevelSchema });
export const accountIdSchema = objectIdSchema;
export type AccountLevelInput = z.infer<typeof accountLevelSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export interface AccountCleanupView {
  id: string;
  operation: 'delete' | 'clear';
  state: 'queued' | 'running' | 'failed';
  processedMedia: number;
  totalMedia: number;
  errorCode?: string;
  requestedAt?: string;
}
export interface AccountCleanupAccepted { accepted: true; cleanup: AccountCleanupView }

export interface AccountView {
  _id: string;
  tenantId: string;
  label: string;
  color?: string;
  phoneNumber?: string;
  provider: 'baileys' | 'cloud_api';
  status: z.infer<typeof accountStatusSchema>;
  desiredState: 'connected' | 'disconnected';
  assignedWorkerId?: string;
  lastError?: string;
  cleanup?: AccountCleanupView;
  capabilities: string[];
}
