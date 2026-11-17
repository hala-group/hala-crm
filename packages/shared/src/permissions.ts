export const PERMISSIONS = [
  'users:read', 'users:create', 'users:update', 'users:delete',
  'roles:read', 'roles:manage',
  'accounts:read', 'accounts:create', 'accounts:connect', 'accounts:update', 'accounts:delete', 'accounts:members', 'accounts:access_all',
  'conversations:read', 'conversations:read_all', 'conversations:assign', 'conversations:archive',
  'messages:send', 'messages:send_media', 'messages:edit', 'messages:delete',
  'contacts:read', 'contacts:update', 'contacts:delete', 'contacts:export',
  'calls:read', 'audit:read', 'settings:manage'
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type SystemRoleKey = 'owner' | 'admin' | 'supervisor' | 'agent' | 'viewer';

export const SYSTEM_ROLES: Record<SystemRoleKey, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  supervisor: [
    'users:read', 'accounts:read', 'conversations:read_all', 'conversations:assign',
    'conversations:archive', 'messages:send', 'messages:send_media', 'messages:edit',
    'messages:delete', 'contacts:read', 'contacts:update', 'contacts:delete',
    'contacts:export', 'calls:read'
  ],
  agent: [
    'accounts:read',
    'conversations:read', 'conversations:read_all', 'conversations:archive', 'messages:send',
    'messages:send_media', 'contacts:read', 'contacts:update', 'calls:read'
  ],
  viewer: ['conversations:read_all', 'contacts:read', 'calls:read']
};

export const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
