import './load-env.js';
import { connect, disconnect, model } from 'mongoose';
import { z } from 'zod';
import { validateEnvironment } from './config/environment.js';
import { tenantSchema, type TenantRecord } from './modules/tenants/tenant.schema.js';
import { roleSchema, type RoleRecord } from './modules/roles/role.schema.js';
import { userSchema, type UserRecord } from './modules/users/user.schema.js';
import { bootstrapTenant } from './modules/tenants/bootstrap-tenant.js';

const bootstrapSchema = z.object({
  BOOTSTRAP_TENANT_SLUG: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  BOOTSTRAP_TENANT_NAME: z.string().min(1),
  BOOTSTRAP_OWNER_EMAIL: z.email().transform(value => value.toLowerCase()),
  BOOTSTRAP_OWNER_PASSWORD: z.string().min(12)
});

async function seed(): Promise<void> {
  const env = validateEnvironment(process.env);
  const bootstrap = bootstrapSchema.parse(process.env);
  await connect(env.MONGO_URI);
  try {
    await bootstrapTenant(
      { tenants: model<TenantRecord>('Tenant', tenantSchema), roles: model<RoleRecord>('Role', roleSchema), users: model<UserRecord>('User', userSchema) },
      { slug: bootstrap.BOOTSTRAP_TENANT_SLUG, name: bootstrap.BOOTSTRAP_TENANT_NAME,
        ownerEmail: bootstrap.BOOTSTRAP_OWNER_EMAIL, ownerPassword: bootstrap.BOOTSTRAP_OWNER_PASSWORD }
    );
    process.stdout.write(`Seeded tenant ${bootstrap.BOOTSTRAP_TENANT_SLUG}\n`);
  } finally {
    await disconnect();
  }
}

seed().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Seed failed'}\n`);
  process.exitCode = 1;
});
