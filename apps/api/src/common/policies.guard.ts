import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isAccountPermission, policyFor, subject, type Permission } from '@hala/shared';
import { type AuthenticatedRequest } from './auth.types.js';
import { POLICY } from './check-policy.decorator.js';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<Permission>(POLICY, [context.getHandler(), context.getClass()]);
    if (!permission) return true;
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    const policy = policyFor(permission);
    if (!principal || !policy || !(principal.role.permissions.includes(permission) ||
      (permission === 'conversations:read' && principal.role.permissions.includes('conversations:read_all'))) ||
      (!isAccountPermission(permission) && !principal.ability.can(policy[0], subject(policy[1], { tenantId: principal.tenantId })))) {
      throw new ForbiddenException('Permission denied');
    }
    return true;
  }
}
