import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface CallPushSubscriptionRecord {
  tenantId: Types.ObjectId; userId: Types.ObjectId; endpoint: string;
  keys: { p256dh: string; auth: string }; expirationTime?: number | null;
  createdAt: Date; updatedAt: Date;
}

export const callPushSubscriptionSchema = new Schema<CallPushSubscriptionRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  endpoint: { type: String, required: true },
  keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  expirationTime: Number
}, { collection: 'call_push_subscriptions', timestamps: true });
callPushSubscriptionSchema.index({ tenantId: 1, endpoint: 1 }, { unique: true });
callPushSubscriptionSchema.plugin(tenantPlugin);
