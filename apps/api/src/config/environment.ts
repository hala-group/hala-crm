import { environmentSchema, tenantSlugSchema } from '@hala/shared';
import { z } from 'zod';

export const apiEnvironmentSchema = environmentSchema.extend({
  BOOTSTRAP_TENANT_SLUG: tenantSlugSchema.optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().regex(/^\d+[smhd]$/).default('15m'),
  JWT_REFRESH_TTL: z.string().regex(/^\d+[smhd]$/).default('30d'),
  CLOUD_APP_SECRET: z.string().optional(), CLOUD_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(), VAPID_PRIVATE_KEY: z.string().optional(), VAPID_SUBJECT: z.string().optional()
}).refine(value => Boolean(value.CLOUD_APP_SECRET) === Boolean(value.CLOUD_WEBHOOK_VERIFY_TOKEN),
    { message: 'Cloud webhook secret and verify token must be configured together' })
  .refine(value => !value.CLOUD_APP_SECRET || Boolean(value.CLOUD_GRAPH_VERSION),
    { message: 'CLOUD_GRAPH_VERSION is required when Cloud webhook is configured' })
  .refine(value => [value.VAPID_PUBLIC_KEY, value.VAPID_PRIVATE_KEY, value.VAPID_SUBJECT].filter(Boolean).length % 3 === 0,
    { message: 'VAPID public key, private key, and subject must be configured together' });

export function validateEnvironment(input: Record<string, unknown>) {
  return apiEnvironmentSchema.parse(input);
}
