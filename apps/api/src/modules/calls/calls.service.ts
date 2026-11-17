import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { defineAbilityFor, isPermission, type CallView, type HalaAbility, type Permission } from '@hala/shared';
import { Types, type Model } from 'mongoose';
import { runInTenant } from '../../common/tenant-context.js';
import { type Principal } from '../../common/auth.types.js';
import { AccountAccessService } from '../access/account-access.service.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type ContactRecord, type ConversationRecord } from '../inbox/inbox.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type CallRecord } from './call.schema.js';

@Injectable()
export class CallsService {
  constructor(
    @InjectModel('Call') private readonly calls: Model<CallRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @Inject(AccountAccessService) private readonly access: AccountAccessService,
    @Optional() @InjectModel('Contact') private readonly contacts?: Model<ContactRecord>,
    @Optional() @InjectModel('WhatsAppAccount') private readonly accounts?: Model<WhatsAppAccountRecord>,
    @Optional() @InjectModel('Conversation') private readonly conversations?: Model<ConversationRecord>
  ) {}

  async list(principal: Principal): Promise<CallView[]> {
    const records = await this.calls
      .find({ $and: [accessibleBy(principal.ability, 'read').ofType('Call')] })
      .sort({ startedAt: -1 })
      .limit(100)
      .lean();

    if (!records.length || !this.contacts || !this.accounts) {
      return records as unknown as CallView[];
    }

    const contactIds = [...new Set(records.map(r => r.contactId?.toString()).filter(Boolean))].map(id => new Types.ObjectId(id));
    const accountIds = [...new Set(records.map(r => r.accountId?.toString()).filter(Boolean))].map(id => new Types.ObjectId(id));

    const [contactList, accountList, convList] = await Promise.all([
      contactIds.length ? this.contacts.find({ _id: { $in: contactIds } }).lean() : Promise.resolve([]),
      accountIds.length ? this.accounts.find({ _id: { $in: accountIds } }).lean() : Promise.resolve([]),
      (this.conversations && accountIds.length && contactIds.length)
        ? this.conversations.find({ accountId: { $in: accountIds }, contactId: { $in: contactIds } }).select('_id accountId contactId').lean()
        : Promise.resolve([])
    ]);

    const contactMap = new Map(contactList.map(c => [c._id.toString(), c]));
    const accountMap = new Map(accountList.map(a => [a._id.toString(), a]));
    const convMap = new Map(convList.map(c => [`${c.accountId.toString()}_${c.contactId.toString()}`, c._id.toString()]));

    return records.map(call => {
      const contact = call.contactId ? contactMap.get(call.contactId.toString()) : undefined;
      const account = call.accountId ? accountMap.get(call.accountId.toString()) : undefined;
      const convId = (call.accountId && call.contactId)
        ? convMap.get(`${call.accountId.toString()}_${call.contactId.toString()}`)
        : undefined;

      return {
        ...call,
        _id: call._id.toString(),
        accountId: call.accountId.toString(),
        contactId: call.contactId?.toString(),
        startedAt: call.startedAt instanceof Date ? call.startedAt.toISOString() : (call.startedAt as unknown as string),
        endedAt: call.endedAt instanceof Date ? call.endedAt.toISOString() : (call.endedAt as unknown as string | undefined),
        contact: contact ? {
          _id: contact._id.toString(),
          displayName: contact.displayName,
          pushName: contact.pushName,
          phoneE164: contact.phoneE164,
          waId: contact.waId,
          avatarUrl: contact.avatarUrl
        } : undefined,
        account: account ? {
          _id: account._id.toString(),
          label: account.label,
          phoneNumber: account.phoneNumber,
          color: account.color
        } : undefined,
        conversationId: convId
      } as unknown as CallView;
    });
  }

  async canReadForUser(tenantId: string, userId: string, callId: string): Promise<boolean> {
    return runInTenant(tenantId, async () => {
      const user = await this.users.findById(userId).lean();
      if (!user) return false;
      const role = await this.roles.findById(user.roleId).lean();
      if (!role) return false;
      const permissions = role.permissions.filter(isPermission) as Permission[];
      const resolved = await this.access.resolve(tenantId, userId, permissions);
      const memberships = [...resolved.accounts].map(([accountId, level]) => ({ accountId, level }));
      const ability: HalaAbility = defineAbilityFor(
        { id: userId, tenantId }, { permissions }, memberships
      );
      return Boolean(await this.calls.exists({
        $and: [{ _id: callId }, accessibleBy(ability, 'read').ofType('Call')]
      }));
    });
  }
}
