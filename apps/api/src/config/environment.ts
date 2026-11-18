import { environmentSchema, tenantSlugSchema } from '@hala/shared';
import { z } from 'zod';

const optionalEnvironmentValue = z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(1).optional());

export const apiEnvironmentSchema = environmentSchema.extend({
  BOOTSTRAP_TENANT_SLUG: tenantSlugSchema.optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().regex(/^\d+[smhd]$/).default('15m'),
  JWT_REFRESH_TTL: z.string().regex(/^\d+[smhd]$/).default('30d'),
  CLOUD_APP_SECRET: z.string().optional(), CLOUD_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(), VAPID_PRIVATE_KEY: z.string().optional(), VAPID_SUBJECT: z.string().optional(),
  FIREBASE_PROJECT_ID: optionalEnvironmentValue,
  FIREBASE_WEB_API_KEY: optionalEnvironmentValue,
  FIREBASE_AUTH_DOMAIN: optionalEnvironmentValue,
  FIREBASE_MESSAGING_SENDER_ID: optionalEnvironmentValue,
  FIREBASE_APP_ID: optionalEnvironmentValue,
  FIREBASE_VAPID_KEY: optionalEnvironmentValue,
  FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64: optionalEnvironmentValue
}).refine(value => Boolean(value.CLOUD_APP_SECRET) === Boolean(value.CLOUD_WEBHOOK_VERIFY_TOKEN),
    { message: 'Cloud webhook secret and verify token must be configured together' })
  .refine(value => !value.CLOUD_APP_SECRET || Boolean(value.CLOUD_GRAPH_VERSION),
    { message: 'CLOUD_GRAPH_VERSION is required when Cloud webhook is configured' })
  .refine(value => [value.VAPID_PUBLIC_KEY, value.VAPID_PRIVATE_KEY, value.VAPID_SUBJECT].filter(Boolean).length % 3 === 0,
    { message: 'VAPID public key, private key, and subject must be configured together' })
  .superRefine((value, context) => {
    if (value.FIREBASE_VAPID_KEY && value.VAPID_PUBLIC_KEY && value.FIREBASE_VAPID_KEY !== value.VAPID_PUBLIC_KEY) {
      context.addIssue({ code: 'custom', path: ['FIREBASE_VAPID_KEY'],
        message: 'Firebase and call push must use the same VAPID key pair' });
    }
    const firebaseFields = [value.FIREBASE_PROJECT_ID, value.FIREBASE_WEB_API_KEY,
      value.FIREBASE_AUTH_DOMAIN, value.FIREBASE_MESSAGING_SENDER_ID, value.FIREBASE_APP_ID,
      value.FIREBASE_VAPID_KEY, value.FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64];
    const configuredCount = firebaseFields.filter(Boolean).length;
    if (configuredCount !== 0 && configuredCount !== firebaseFields.length) {
      context.addIssue({ code: 'custom', path: ['FIREBASE_PROJECT_ID'],
        message: 'Firebase message push settings must be configured together' });
      return;
    }
    const encodedAccount = value.FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64;
    if (!encodedAccount) return;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedAccount)) {
      context.addIssue({ code: 'custom', path: ['FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64'],
        message: 'Firebase service account must be base64 encoded' });
      return;
    }
    try {
      const account = z.object({
        project_id: z.string().min(1),
        client_email: z.string().email(),
        private_key: z.string().min(1)
      }).parse(JSON.parse(Buffer.from(encodedAccount, 'base64').toString('utf8')));
      if (account.project_id !== value.FIREBASE_PROJECT_ID) {
        context.addIssue({ code: 'custom', path: ['FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64'],
          message: 'Firebase service account project does not match FIREBASE_PROJECT_ID' });
      }
    } catch {
      context.addIssue({ code: 'custom', path: ['FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64'],
        message: 'Firebase service account JSON is invalid' });
    }
  });

export function validateEnvironment(input: Record<string, unknown>) {
  return apiEnvironmentSchema.parse(input);
}
