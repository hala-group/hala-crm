import { Schema } from 'mongoose';

export interface TenantRecord {
  slug: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export const tenantSchema = new Schema<TenantRecord>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true }
  },
  { collection: 'tenants', timestamps: true }
);
