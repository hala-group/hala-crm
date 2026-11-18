import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface MessagePushInstallationRecord {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  fid: string;
  lastRegisteredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const messagePushInstallationSchema = new Schema<MessagePushInstallationRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  fid: { type: String, required: true },
  lastRegisteredAt: { type: Date, required: true, default: Date.now }
}, { collection: 'message_push_installations', timestamps: true });

messagePushInstallationSchema.index({ tenantId: 1, fid: 1 }, { unique: true });
messagePushInstallationSchema.index({ tenantId: 1, userId: 1 });
messagePushInstallationSchema.plugin(tenantPlugin);
