import { InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { type Principal } from '../../common/auth.types.js';
import { currentRequestMeta, currentTenantId } from '../../common/tenant-context.js';
import { type AuditRecord } from './audit.schema.js';

@Injectable()
export class AuditService {
  constructor(@InjectModel('AuditLog') private readonly audits: Model<AuditRecord>) {}

  async record(actorUserId: string, action: string, resourceType: string, resourceId: string, meta?: Record<string, unknown>): Promise<void> {
    await this.audits.create({
      tenantId: new Types.ObjectId(currentTenantId()),
      actorUserId: new Types.ObjectId(actorUserId),
      action, resourceType, resourceId, meta, ...currentRequestMeta(), at: new Date()
    });
  }

  async list(principal: Principal) {
    return this.audits.find({ $and: [accessibleBy(principal.ability).ofType('AuditLog')] })
      .sort({ at: -1 }).limit(100).lean();
  }
}
