import { hash, argon2id } from 'argon2';
import { type Model } from 'mongoose';
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLES } from '@hala/shared';
import { runInTenant } from '../../common/tenant-context.js';
import { type TenantRecord } from './tenant.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';

export interface BootstrapInput { slug: string; name: string; ownerEmail: string; ownerPassword: string }
export interface BootstrapModels { tenants: Model<TenantRecord>; roles: Model<RoleRecord>; users: Model<UserRecord> }

export async function bootstrapTenant(models: BootstrapModels, input: BootstrapInput): Promise<string> {
  let tenant = await models.tenants.findOne({ slug: input.slug });
  if (!tenant) tenant = await models.tenants.create({ slug: input.slug, name: input.name });
  const tenantId = tenant._id.toString();
  await runInTenant(tenantId, async () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      let role = await models.roles.findOne({ key });
      if (!role) {
        role = await models.roles.create({ tenantId: tenant._id, key, name: key, isSystem: true, permissions: [...SYSTEM_ROLES[key]] });
      } else {
        role.permissions = [...SYSTEM_ROLES[key]];
        await role.save();
      }
    }
    const ownerRole = await models.roles.findOne({ key: 'owner' });
    if (!ownerRole) throw new Error('Owner role seed failed');
    const existing = await models.users.findOne({ email: input.ownerEmail });
    if (!existing) {
      await models.users.create({
        tenantId: tenant._id,
        email: input.ownerEmail,
        name: 'Owner', roleId: ownerRole._id, status: 'active',
        passwordHash: await hash(input.ownerPassword, { type: argon2id })
      });
    }
  });
  return tenantId;
}
