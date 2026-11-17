import { describe, expect, it } from 'vitest';
import { loginSchema } from './identity.js';

describe('loginSchema', () => {
  it('allows the deployment to choose the tenant through environment config', () => {
    expect(loginSchema.safeParse({ email: 'user@example.com', password: 'secret' }).success).toBe(true);
  });

  it('still accepts an explicit tenant slug for multi-tenant clients', () => {
    expect(loginSchema.safeParse({ tenantSlug: 'example-company', email: 'user@example.com', password: 'secret' }).success).toBe(true);
  });
});
