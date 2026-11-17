import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import * as webPush from 'web-push';
import { type UserRecord } from '../users/user.schema.js';
import { type RedisBusService } from '../access/redis-bus.service.js';
import { type CallPushSubscriptionRecord } from './call-push.schema.js';
import { type CallsService } from './calls.service.js';
import { CallPushService } from './call-push.service.js';

vi.mock('web-push', () => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue({}) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('CallPushService', () => {
  it('sends only to a user who can still read the call and claims the event once', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:admin@example.com');
    const tenantId = new Types.ObjectId().toString();
    const allowedId = new Types.ObjectId();
    const deniedId = new Types.ObjectId();
    const users = { find: vi.fn(() => ({ select: () => ({ lean: async () => [{ _id: allowedId }, { _id: deniedId }] }) })) };
    const subscription = { tenantId: new Types.ObjectId(tenantId), userId: allowedId,
      endpoint: 'https://fcm.googleapis.com/fcm/send/example', expirationTime: null,
      keys: { p256dh: 'p256dh', auth: 'auth' } };
    const subscriptions = { find: vi.fn(() => ({ lean: async () => [subscription] })), deleteOne: vi.fn() };
    const calls = { canReadForUser: vi.fn(async (_tenant: string, userId: string) => userId === allowedId.toString()) };
    const bus = { consume: vi.fn().mockResolvedValue(true) };
    const service = new CallPushService(subscriptions as unknown as Model<CallPushSubscriptionRecord>,
      users as unknown as Model<UserRecord>, calls as unknown as CallsService, bus as unknown as RedisBusService);

    await service.deliver({ type: 'call.missed', tenantId, accountId: new Types.ObjectId().toString(),
      callId: new Types.ObjectId().toString(), waCallId: 'wa-call-1', contactId: new Types.ObjectId().toString(), isVideo: false });

    expect(bus.consume).toHaveBeenCalledWith(expect.stringContaining('call-push:'), 1, 86_400);
    expect(calls.canReadForUser).toHaveBeenCalledTimes(2);
    expect(subscriptions.find).toHaveBeenCalledOnce();
    expect(webPush.sendNotification).toHaveBeenCalledOnce();
    expect(webPush.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ endpoint: subscription.endpoint }),
      expect.stringContaining('مكالمة فائتة'), { TTL: 86_400 });
  });
});
