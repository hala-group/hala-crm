import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';
import { type Request, type Response, type NextFunction } from 'express';

interface TenantScope { tenantId: string; ip?: string; userAgent?: string }
const tenantStorage = new AsyncLocalStorage<TenantScope>();

export function currentTenantId(): string {
  const scope = tenantStorage.getStore();
  if (!scope) throw new ForbiddenException('Tenant context is required');
  return scope.tenantId;
}

export function currentRequestMeta(): Pick<TenantScope, 'ip' | 'userAgent'> {
  const { ip, userAgent } = tenantStorage.getStore() ?? { tenantId: '' };
  return { ip, userAgent };
}

export function enterTenant(tenantId: string, meta: Pick<TenantScope, 'ip' | 'userAgent'> = {}): void {
  const scope = tenantStorage.getStore();
  if (scope) Object.assign(scope, { tenantId, ...meta });
  else tenantStorage.enterWith({ tenantId, ...meta });
}

export function tenantContextMiddleware(_request: Request, _response: Response, next: NextFunction): void {
  tenantStorage.run({ tenantId: '' }, next);
}

export function runInTenant<T>(tenantId: string, callback: () => T, meta: Pick<TenantScope, 'ip' | 'userAgent'> = {}): T {
  return tenantStorage.run({ tenantId, ...meta }, callback);
}
