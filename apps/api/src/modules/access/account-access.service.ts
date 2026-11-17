import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { type AccountLevel, type AccountMembership, type AccessChangedEvent } from '@hala/shared';
import { runInTenant } from '../../common/tenant-context.js';
import { type AccountMemberRecord } from '../whatsapp-accounts/account.schema.js';
import { RedisBusService } from './redis-bus.service.js';

export interface AccountAccess { all: boolean; accounts: Map<string, AccountLevel> }

@Injectable()
export class AccountAccessService {
  constructor(
    @InjectModel('AccountMember') private readonly members: Model<AccountMemberRecord>,
    @Inject(RedisBusService) private readonly bus: RedisBusService
  ) {}

  async resolve(tenantId: string, userId: string, permissions: readonly string[]): Promise<AccountAccess> {
    const all = permissions.includes('accounts:access_all');
    const cacheKey = `access:${tenantId}:${userId}`;
    let memberships: AccountMembership[] | null = null;
    try {
      const cached = await this.bus.get(cacheKey);
      if (cached) memberships = JSON.parse(cached) as AccountMembership[];
    } catch { /* MongoDB remains the authority. */ }
    if (!memberships) {
      const records = await runInTenant(tenantId, async () => this.members.find({ userId: new Types.ObjectId(userId) }).lean());
      memberships = records.map(member => ({ accountId: member.accountId.toString(), level: member.level }));
      try { await this.bus.set(cacheKey, JSON.stringify(memberships), 15); } catch { /* Cache is optional. */ }
    }
    return { all, accounts: new Map(memberships.map(member => [member.accountId, member.level])) };
  }

  async invalidate(tenantId: string, userId: string, accountId: string): Promise<void> {
    try { await this.bus.del(`access:${tenantId}:${userId}`); } catch { /* Cache is optional. */ }
    const event: AccessChangedEvent = { type: 'access.changed', tenantId, userId, accountId };
    await this.bus.publish(event);
  }
}
