import { createMongoAbility, subject, type ForcedSubject, type MongoAbility } from '@casl/ability';
import { type Permission } from './permissions.js';

export type AccountLevel = 'view' | 'reply' | 'manage';
export type HalaAbility = MongoAbility<[string, string | ForcedSubject<string>]>;

export interface AbilityUser { id: string; tenantId: string }
export interface AbilityRole { permissions: readonly Permission[] }
export interface AccountMembership { accountId: string; level: AccountLevel }

const levels: Record<AccountLevel, number> = { view: 0, reply: 1, manage: 2 };
const accountActions: Partial<Record<Permission, [string, string, AccountLevel]>> = {
  'accounts:read': ['read', 'WhatsAppAccount', 'view'],
  'accounts:connect': ['connect', 'WhatsAppAccount', 'manage'],
  'accounts:update': ['update', 'WhatsAppAccount', 'manage'],
  'accounts:delete': ['delete', 'WhatsAppAccount', 'manage'],
  'accounts:members': ['members', 'WhatsAppAccount', 'manage'],
  'conversations:read': ['read', 'Conversation', 'view'],
  'conversations:read_all': ['read_all', 'Conversation', 'view'],
  'conversations:assign': ['assign', 'Conversation', 'reply'],
  'conversations:archive': ['archive', 'Conversation', 'reply'],
  'messages:send': ['send', 'Message', 'reply'],
  'messages:send_media': ['send_media', 'Message', 'reply'],
  'messages:edit': ['edit', 'Message', 'reply'],
  'messages:delete': ['delete', 'Message', 'reply'],
  'calls:read': ['read', 'Call', 'view']
};
export const isAccountPermission = (permission: Permission): boolean => Boolean(accountActions[permission]);

const tenantActions: Partial<Record<Permission, [string, string]>> = {
  'users:read': ['read', 'User'], 'users:create': ['create', 'User'],
  'users:update': ['update', 'User'], 'users:delete': ['delete', 'User'],
  'roles:read': ['read', 'Role'], 'roles:manage': ['manage', 'Role'],
  'accounts:create': ['create', 'WhatsAppAccount'],
  'contacts:read': ['read', 'Contact'], 'contacts:update': ['update', 'Contact'],
  'contacts:delete': ['delete', 'Contact'], 'contacts:export': ['export', 'Contact'],
  'audit:read': ['read', 'AuditLog'], 'settings:manage': ['manage', 'Tenant']
};

export const policyFor = (permission: Permission): readonly [string, string] | undefined =>
  tenantActions[permission] ?? accountActions[permission]?.slice(0, 2) as [string, string] | undefined;

export function defineAbilityFor(
  user: AbilityUser,
  role: AbilityRole,
  memberships: readonly AccountMembership[]
): HalaAbility {
  const rules: Array<{ action: string; subject: string; conditions?: Record<string, unknown> }> = [];
  const allAccounts = role.permissions.includes('accounts:access_all');
  for (const permission of role.permissions) {
    const tenantAction = tenantActions[permission];
    if (tenantAction) {
      rules.push({ action: tenantAction[0], subject: tenantAction[1], conditions: { tenantId: user.tenantId } });
      continue;
    }
    const accountAction = accountActions[permission];
    if (!accountAction) continue;
    const [action, resource, level] = accountAction;
    const accountIds = memberships.filter(member => levels[member.level] >= levels[level]).map(member => member.accountId);
    if (!allAccounts && accountIds.length === 0) continue;
    const conditions: Record<string, unknown> = { tenantId: user.tenantId };
    if (!allAccounts) conditions[resource === 'WhatsAppAccount' ? '_id' : 'accountId'] = { $in: accountIds };
    if (permission === 'conversations:read') {
      conditions.assignedUserId = { $in: [user.id, null] };
    }
    rules.push({ action, subject: resource, conditions });
    if (permission === 'conversations:read_all') {
      rules.push({ action: 'read', subject: resource, conditions: { ...conditions } });
    }
    if (permission === 'conversations:read' || permission === 'conversations:read_all') {
      const mediaConditions: Record<string, unknown> = { tenantId: user.tenantId };
      if (!allAccounts) mediaConditions.accountId = { $in: accountIds };
      rules.push({ action: 'read', subject: 'Message', conditions: mediaConditions });
      rules.push({ action: 'read', subject: 'Media', conditions: mediaConditions });
    }
  }
  return createMongoAbility<[string, string | ForcedSubject<string>]>(rules);
}

export { subject };
