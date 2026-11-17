import { Schema, Types } from 'mongoose';
import { type Permission } from '@hala/shared';
import { tenantPlugin } from '../../common/tenant.plugin.js';

export interface RoleRecord {
  tenantId: Types.ObjectId;
  name: string;
  key?: string;
  isSystem: boolean;
  permissions: Permission[];
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const roleSchema = new Schema<RoleRecord>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    key: { type: String },
    isSystem: { type: Boolean, default: false },
    permissions: [{ type: String, required: true }],
    description: String
  },
  { collection: 'roles', timestamps: true }
);
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });
roleSchema.index({ tenantId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
roleSchema.plugin(tenantPlugin);
