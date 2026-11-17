import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface RefreshSessionRecord {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvitationRecord {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const refreshSessionSchema = new Schema<RefreshSessionRecord>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    familyId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    revokedAt: Date
  },
  { collection: 'refresh_sessions', timestamps: true }
);
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshSessionSchema.index({ tenantId: 1, familyId: 1 });
refreshSessionSchema.plugin(tenantPlugin);

export const invitationSchema = new Schema<InvitationRecord>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    consumedAt: Date
  },
  { collection: 'invitations', timestamps: true }
);
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
invitationSchema.plugin(tenantPlugin);
