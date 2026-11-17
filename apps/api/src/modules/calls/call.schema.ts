import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface CallRecord {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; contactId: Types.ObjectId; waCallId: string;
  direction: 'in' | 'out'; isVideo: boolean; status: 'ringing' | 'missed' | 'rejected' | 'accepted' | 'ended';
  startedAt: Date; endedAt?: Date; createdAt: Date; updatedAt: Date;
}

export const callSchema = new Schema<CallRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true }, accountId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true }, waCallId: { type: String, required: true },
  direction: { type: String, enum: ['in', 'out'], required: true }, isVideo: { type: Boolean, required: true },
  status: { type: String, enum: ['ringing', 'missed', 'rejected', 'accepted', 'ended'], required: true },
  startedAt: { type: Date, required: true }, endedAt: Date
}, { collection: 'calls', timestamps: true });
callSchema.index({ tenantId: 1, accountId: 1, waCallId: 1 }, { unique: true });
callSchema.index({ tenantId: 1, accountId: 1, startedAt: -1 });
callSchema.plugin(tenantPlugin);
