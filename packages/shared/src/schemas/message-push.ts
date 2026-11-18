import { z } from 'zod';

export const firebaseInstallationSchema = z.string().trim().min(1).max(128);

export const messagePushInstallationSchema = z.object({ fid: firebaseInstallationSchema });
export type MessagePushInstallationInput = z.infer<typeof messagePushInstallationSchema>;

export const messagePushConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    config: z.object({
      apiKey: z.string().min(1),
      authDomain: z.string().min(1),
      projectId: z.string().min(1),
      messagingSenderId: z.string().min(1),
      appId: z.string().min(1)
    }),
    vapidKey: z.string().min(1)
  })
]);
export type MessagePushConfig = z.infer<typeof messagePushConfigSchema>;
