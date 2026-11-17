import { describe, expect, it } from 'vitest';
import { defineAbilityFor, subject } from './ability.js';
import { SYSTEM_ROLES } from './permissions.js';

describe('role and account ability intersection', () => {
  const user = { id: 'user-1', tenantId: 'tenant-1' };

  it('limits an agent with view membership to reads on that account', () => {
    const ability = defineAbilityFor(user, { permissions: SYSTEM_ROLES.agent }, [{ accountId: 'account-1', level: 'view' }]);
    expect(ability.can('read', subject('Conversation', { tenantId: 'tenant-1', accountId: 'account-1', assignedUserId: null }))).toBe(true);
    expect(ability.can('send', subject('Message', { tenantId: 'tenant-1', accountId: 'account-1' }))).toBe(false);
    expect(ability.can('read', subject('Conversation', { tenantId: 'tenant-1', accountId: 'account-2', assignedUserId: null }))).toBe(false);
  });

  it('keeps owner access inside the tenant', () => {
    const ability = defineAbilityFor(user, { permissions: SYSTEM_ROLES.owner }, []);
    expect(ability.can('read', subject('User', { tenantId: 'tenant-1' }))).toBe(true);
    expect(ability.can('read', subject('User', { tenantId: 'tenant-2' }))).toBe(false);
    expect(ability.can('update', subject('Contact', { tenantId: 'tenant-1' }))).toBe(true);
    expect(ability.can('update', subject('Contact', { tenantId: 'tenant-2' }))).toBe(false);
    expect(ability.can('send', subject('Message', { tenantId: 'tenant-1', accountId: 'any-account' }))).toBe(true);
  });

  it('intersects account membership levels with role permissions', () => {
    const role = { permissions: ['accounts:read', 'accounts:connect', 'messages:send'] as const };
    const ability = defineAbilityFor(user, role, [
      { accountId: 'view-account', level: 'view' },
      { accountId: 'reply-account', level: 'reply' },
      { accountId: 'manage-account', level: 'manage' }
    ]);
    expect(ability.can('read', subject('WhatsAppAccount', { tenantId: user.tenantId, _id: 'view-account' }))).toBe(true);
    expect(ability.can('connect', subject('WhatsAppAccount', { tenantId: user.tenantId, _id: 'view-account' }))).toBe(false);
    expect(ability.can('send', subject('Message', { tenantId: user.tenantId, accountId: 'reply-account' }))).toBe(true);
    expect(ability.can('connect', subject('WhatsAppAccount', { tenantId: user.tenantId, _id: 'manage-account' }))).toBe(true);
    expect(ability.can('read', subject('WhatsAppAccount', { tenantId: user.tenantId, _id: 'foreign-account' }))).toBe(false);
  });
});
