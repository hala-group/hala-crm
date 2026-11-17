import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import * as webPush from 'web-push';
import { type CallPushSubscriptionInput, type DomainEvent } from '@hala/shared';
import { runInTenant } from '../../common/tenant-context.js';
import { type Principal } from '../../common/auth.types.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { type UserRecord } from '../users/user.schema.js';
import { type CallPushSubscriptionRecord } from './call-push.schema.js';
import { CallsService } from './calls.service.js';

type CallEvent = Extract<DomainEvent, { type: 'call.incoming' | 'call.missed' }>;

@Injectable()
export class CallPushService {
  private readonly logger = new Logger(CallPushService.name);
  private readonly publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  private readonly configured = Boolean(this.publicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);

  constructor(
    @InjectModel('CallPushSubscription') private readonly subscriptions: Model<CallPushSubscriptionRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @Inject(CallsService) private readonly calls: CallsService,
    @Inject(RedisBusService) private readonly bus: RedisBusService
  ) {
    if (this.configured) webPush.setVapidDetails(process.env.VAPID_SUBJECT!, this.publicKey, process.env.VAPID_PRIVATE_KEY!);
  }

  key(): { publicKey: string } { return { publicKey: this.publicKey }; }

  async subscribe(principal: Principal, input: CallPushSubscriptionInput): Promise<{ ok: true }> {
    if (!this.configured) throw new ServiceUnavailableException('Call push is not configured');
    await this.subscriptions.updateOne({ tenantId: new Types.ObjectId(principal.tenantId), endpoint: input.endpoint }, {
      $set: { userId: new Types.ObjectId(principal.id), keys: input.keys, expirationTime: input.expirationTime ?? null }
    }, { upsert: true });
    return { ok: true };
  }

  async unsubscribe(principal: Principal, endpoint: string): Promise<{ ok: true }> {
    await this.subscriptions.deleteOne({ tenantId: new Types.ObjectId(principal.tenantId),
      userId: new Types.ObjectId(principal.id), endpoint });
    return { ok: true };
  }

  async deliver(event: CallEvent): Promise<void> {
    if (!this.configured) return;
    try {
      if (!await this.bus.consume(`call-push:${event.tenantId}:${event.callId}:${event.type}`, 1, 86_400)) return;
      await runInTenant(event.tenantId, async () => {
        const users = await this.users.find({ tenantId: new Types.ObjectId(event.tenantId), status: 'active' }).select('_id').lean();
        const payload = JSON.stringify({ notification: {
          title: event.type === 'call.incoming' ? 'مكالمة واردة' : 'مكالمة فائتة',
          body: event.isVideo ? 'مكالمة فيديو عبر واتساب' : 'مكالمة صوتية عبر واتساب',
          icon: '/assets/imgs/logo.webp', tag: `call:${event.callId}:${event.type}`,
          data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/calls' } } }
        } });
        for (const user of users) {
          const userId = user._id.toString();
          if (!await this.calls.canReadForUser(event.tenantId, userId, event.callId)) continue;
          const subscriptions = await this.subscriptions.find({ tenantId: new Types.ObjectId(event.tenantId), userId: user._id }).lean();
          await Promise.all(subscriptions.map(async subscription => {
            try {
              await webPush.sendNotification({ endpoint: subscription.endpoint, expirationTime: subscription.expirationTime,
                keys: subscription.keys }, payload, { TTL: event.type === 'call.incoming' ? 60 : 86_400 });
            } catch (error) {
              const status = (error as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) {
                await this.subscriptions.deleteOne({ tenantId: subscription.tenantId, userId: subscription.userId,
                  endpoint: subscription.endpoint });
              } else this.logger.warn(`Call push delivery failed with status ${status ?? 'unknown'}`);
            }
          }));
        }
      });
    } catch (error) {
      this.logger.error('Call push fan-out failed', error instanceof Error ? error.stack : String(error));
    }
  }
}
