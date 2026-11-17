import { computed } from '@angular/core';
import { signalStore, withComputed, withMethods, withState, patchState } from '@ngrx/signals';
import { defineAbilityFor, isAccountPermission, policyFor, subject, type Permission } from '@hala/shared';
import { type Me } from './models';

export const PermissionsStore = signalStore(
  { providedIn: 'root' },
  withState<{ me: Me | null }>({ me: null }),
  withComputed(({ me }) => ({
    ability: computed(() => {
      const current = me();
      return defineAbilityFor(
        { id: current?.id ?? '', tenantId: current?.tenantId ?? '' },
        { permissions: current?.role.permissions ?? [] },
        current?.accountMemberships ?? []
      );
    })
  })),
  withMethods(store => ({
    setCurrent(me: Me | null): void { patchState(store, { me }); },
    can(permission: Permission, accountId?: string): boolean {
      const rule = policyFor(permission);
      const current = store.me();
      if (!rule || !current) return false;
      const allowedFor = (id: string | undefined) => store.ability().can(rule[0], subject(rule[1], {
        tenantId: current.tenantId, accountId: id, _id: id, assignedUserId: null
      }));
      if (accountId || !isAccountPermission(permission)) return allowedFor(accountId);
      if (current.role.permissions.includes('accounts:access_all')) return allowedFor('*');
      return current.accountMemberships.some(member => allowedFor(member.accountId));
    }
  }))
);
