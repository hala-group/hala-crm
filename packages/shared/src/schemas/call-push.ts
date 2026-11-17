import { z } from 'zod';

const endpointSchema = z.url().startsWith('https://').max(2048).refine(value => {
  const host = new URL(value).hostname.toLowerCase();
  return host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || host === 'webpush.push.apple.com' || host.endsWith('.notify.windows.com');
}, { message: 'Unsupported browser push service' });

export const callPushSubscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(16).max(512), auth: z.string().min(8).max(512) })
});

export const removeCallPushSubscriptionSchema = z.object({ endpoint: endpointSchema });
export type CallPushSubscriptionInput = z.infer<typeof callPushSubscriptionSchema>;
