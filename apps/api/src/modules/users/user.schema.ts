import { Schema, Types } from 'mongoose';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export type UserStatus = 'invited' | 'active' | 'suspended';
export interface UserRecord {
  tenantId: Types.ObjectId;
  email: string;
  passwordHash?: string;
  name: string;
  avatarUrl?: string;
  roleId: Types.ObjectId;
  status: UserStatus;
  lastLoginAt?: Date;
  preferences: { locale: string; theme: string };
  createdAt: Date;
  updatedAt: Date;
}

export const userSchema = new Schema<UserRecord>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    email: { type: String, required: true, lowercase: true },
    passwordHash: { type: String, select: false },
    name: { type: String, required: true },
    avatarUrl: String,
    roleId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['invited', 'active', 'suspended'], required: true },
    lastLoginAt: Date,
    preferences: {
      locale: { type: String, default: 'ar' },
      theme: { type: String, default: 'light' }
    }
  },
  { collection: 'users', timestamps: true }
);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.plugin(tenantPlugin);
