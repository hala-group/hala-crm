import { type AccountMembership, type Permission } from '@hala/shared';

export interface Me {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  status: 'active';
  role: { id: string; name: string; key?: string; permissions: Permission[] };
  accountMemberships: AccountMembership[];
  preferences?: { locale: string; theme: string };
}

export interface UserVm {
  _id: string;
  email: string;
  name: string;
  roleId: string;
  status: 'active' | 'invited' | 'suspended';
}

export interface RoleVm {
  _id: string;
  name: string;
  key?: string;
  isSystem: boolean;
  description?: string;
  permissions: Permission[];
}
