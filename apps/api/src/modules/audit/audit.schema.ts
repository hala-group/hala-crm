import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface AuditRecord {
  tenantId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  action: string;
  resourceType: string;
  resourceId: string;
  accountId?: Types.ObjectId;
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const auditSchema = new Schema<AuditRecord>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    accountId: Schema.Types.ObjectId,
    meta: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now }
  },
  { collection: 'audit_logs', timestamps: true }
);
auditSchema.index({ tenantId: 1, at: -1 });
auditSchema.plugin(tenantPlugin);
