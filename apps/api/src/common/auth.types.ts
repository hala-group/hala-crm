import { type HalaAbility, type Permission, type AccountMembership } from '@hala/shared';
import { type Request } from 'express';

export interface Principal {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  status: 'active';
  role: { id: string; name: string; key?: string; permissions: Permission[] };
  ability: HalaAbility;
  accountMemberships: AccountMembership[];
}

export interface AuthenticatedRequest extends Request { principal: Principal }
