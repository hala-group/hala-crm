import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { PermissionsStore } from './permissions.store';
import { type Me } from './models';

describe('PermissionsStore', () => {
  it('updates visible actions when the current user changes', () => {
    const injector = createEnvironmentInjector([PermissionsStore], Injector.NULL);
    const store = injector.get(PermissionsStore);
    const me: Me = {
      id: 'user-1', tenantId: 'tenant-1', email: 'agent@example.com', name: 'Agent', status: 'active',
      role: { id: 'role-1', name: 'Agent', permissions: ['users:read', 'accounts:read', 'messages:send'] },
      accountMemberships: [{ accountId: 'account-1', level: 'reply' }]
    };
    expect(store.can('users:read')).toBe(false);
    store.setCurrent(me);
    expect(store.can('users:read')).toBe(true);
    expect(store.can('accounts:read')).toBe(true);
    expect(store.can('messages:send', 'account-1')).toBe(true);
    expect(store.can('messages:send', 'account-2')).toBe(false);
    store.setCurrent({ ...me, accountMemberships: [{ accountId: 'account-1', level: 'view' }] });
    expect(store.can('messages:send', 'account-1')).toBe(false);
    store.setCurrent(null);
    expect(store.can('users:read')).toBe(false);
    injector.destroy();
  });
});
