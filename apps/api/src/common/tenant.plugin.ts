import { ForbiddenException } from '@nestjs/common';
import { Schema, type HydratedDocument, type Query } from 'mongoose';
import { currentTenantId } from './tenant-context.js';

type TenantDocument = HydratedDocument<{ tenantId: string }>;

export function tenantPlugin(schema: Schema): void {
  schema.pre(
    /^(find|count|distinct|update|delete|replace)/,
    function (this: Query<unknown, unknown>) {
      const tenantId = currentTenantId();
      this.setQuery({ $and: [this.getQuery(), { tenantId }] });
    }
  );
  schema.pre('validate', function (this: TenantDocument) {
    const tenantId = currentTenantId();
    if (this.tenantId && this.tenantId.toString() !== tenantId) {
      throw new ForbiddenException('Cross-tenant write');
    }
    this.set('tenantId', tenantId);
  });
  schema.pre('aggregate', function () {
    this.pipeline().unshift({ $match: { tenantId: currentTenantId() } });
  });
}
