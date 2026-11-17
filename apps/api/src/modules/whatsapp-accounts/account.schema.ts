import { Schema, Types } from 'mongoose';
import { type AccountLevel, type AccountView } from '@hala/shared';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface WhatsAppAccountRecord extends Omit<AccountView, '_id' | 'tenantId' | 'capabilities'> {
  tenantId: Types.ObjectId;
  settings: { autoReadReceipts: boolean; sendPacing: { minDelayMs: number; maxDelayMs: number } };
  assignedWorkerId?: string;
  leaseUpdatedAt?: Date;
  lastConnectedAt?: Date;
  providerConfig?: { phoneNumberId?: string; wabaId?: string; tokenEnc?: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountMemberRecord {
  tenantId: Types.ObjectId;
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  level: AccountLevel;
  grantedBy: Types.ObjectId;
  grantedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WaAuthStateRecord {
  tenantId: Types.ObjectId;
  accountId: Types.ObjectId;
  key: string;
  valueEnc: string;
  fencingToken: number;
  createdAt: Date;
  updatedAt: Date;
}

export const accountSchema = new Schema<WhatsAppAccountRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  label: { type: String, required: true }, color: String, phoneNumber: String,
  provider: { type: String, enum: ['baileys', 'cloud_api'], default: 'baileys' },
  status: { type: String, enum: ['created', 'qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out', 'error'], default: 'created' },
  desiredState: { type: String, enum: ['connected', 'disconnected'], default: 'disconnected' },
  assignedWorkerId: String, leaseUpdatedAt: Date, lastConnectedAt: Date, lastError: String,
  providerConfig: { phoneNumberId: String, wabaId: String, tokenEnc: String },
  settings: {
    autoReadReceipts: { type: Boolean, default: false },
    sendPacing: { minDelayMs: { type: Number, default: 500 }, maxDelayMs: { type: Number, default: 1500 } }
  }
}, { collection: 'whatsapp_accounts', timestamps: true });
accountSchema.index({ tenantId: 1, desiredState: 1 });
accountSchema.index({ 'providerConfig.phoneNumberId': 1 }, { unique: true,
  partialFilterExpression: { provider: 'cloud_api', 'providerConfig.phoneNumberId': { $type: 'string' } } });
accountSchema.plugin(tenantPlugin);

export const accountMemberSchema = new Schema<AccountMemberRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  level: { type: String, enum: ['view', 'reply', 'manage'], required: true },
  grantedBy: { type: Schema.Types.ObjectId, required: true },
  grantedAt: { type: Date, default: Date.now }
}, { collection: 'whatsapp_account_members', timestamps: true });
accountMemberSchema.index({ accountId: 1, userId: 1 }, { unique: true });
accountMemberSchema.index({ tenantId: 1, userId: 1 });
accountMemberSchema.plugin(tenantPlugin);

export const waAuthStateSchema = new Schema<WaAuthStateRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  valueEnc: { type: String, required: true },
  fencingToken: { type: Number, required: true }
}, { collection: 'wa_auth_states', timestamps: true });
waAuthStateSchema.index({ accountId: 1, key: 1 }, { unique: true });
waAuthStateSchema.plugin(tenantPlugin);
