import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { type Permission } from '@hala/shared';
import { PermissionsStore } from './permissions.store';

export const permissionGuard = (permission: Permission): CanActivateFn => () => {
  const permissions = inject(PermissionsStore);
  const router = inject(Router);
  return (permissions.can(permission) || (permission === 'conversations:read' && permissions.can('conversations:read_all')))
    ? true : router.createUrlTree(['/dashboard']);
};
