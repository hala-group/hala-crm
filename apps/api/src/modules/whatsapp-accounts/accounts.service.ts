import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { BAILEYS_CAPABILITIES, CLOUD_API_CAPABILITIES, type AccountLevel, type CreateAccountInput, type UpdateAccountInput, type AccountView } from '@hala/shared';
import { encryptSecret } from '@hala/shared/secrets';
import { type Principal } from '../../common/auth.types.js';
import { currentTenantId } from '../../common/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountAccessService } from '../access/account-access.service.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { type UserRecord } from '../users/user.schema.js';
import { AccountCommandService } from './account-command.service.js';
import { type AccountMemberRecord, type WaAuthStateRecord, type WhatsAppAccountRecord } from './account.schema.js';
import { createStorageRegistry } from '@hala/shared/storage';

@Injectable()
export class AccountsService {
  constructor(
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('AccountMember') private readonly members: Model<AccountMemberRecord>,
    @InjectModel('WaAuthState') private readonly authStates: Model<WaAuthStateRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<Record<string, unknown>>,
    @InjectModel('Message') private readonly messages: Model<Record<string, unknown>>,
    @InjectModel('Media') private readonly media: Model<Record<string, unknown>>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountAccessService) private readonly access: AccountAccessService,
    @Inject(AccountCommandService) private readonly commands: AccountCommandService,
    @Inject(RedisBusService) private readonly bus: RedisBusService
  ) {}
  private readonly storage = createStorageRegistry();

  private view(account: WhatsAppAccountRecord & { _id: Types.ObjectId }): AccountView {
    return {
      _id: account._id.toString(), tenantId: account.tenantId.toString(), label: account.label,
      color: account.color, phoneNumber: account.phoneNumber, provider: account.provider,
      status: account.status, desiredState: account.desiredState, assignedWorkerId: account.assignedWorkerId,
      lastError: account.lastError, capabilities: [...(account.provider === 'cloud_api' ? CLOUD_API_CAPABILITIES : BAILEYS_CAPABILITIES)]
    };
  }

  private scoped(principal: Principal, action: 'read' | 'update' | 'delete' | 'connect' | 'members') {
    return accessibleBy(principal.ability, action).ofType('WhatsAppAccount');
  }

  async list(principal: Principal): Promise<AccountView[]> {
    const records = await this.accounts.find({ $and: [this.scoped(principal, 'read')] }).sort({ createdAt: -1 }).lean();
    return records.map(record => this.view(record));
  }

  async get(principal: Principal, id: string, action: 'read' | 'update' | 'delete' | 'connect' | 'members' = 'read') {
    const account = await this.accounts.findOne({ $and: [{ _id: id }, this.scoped(principal, action)] });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async details(principal: Principal, id: string): Promise<AccountView> {
    return this.view(await this.get(principal, id));
  }

  async create(principal: Principal, input: CreateAccountInput): Promise<AccountView> {
    const provider = input.provider ?? 'baileys';
    const providerConfig = input.cloud ? {
      phoneNumberId: input.cloud.phoneNumberId, wabaId: input.cloud.wabaId,
      tokenEnc: encryptSecret(input.cloud.accessToken, process.env.ENCRYPTION_KEY_BASE64 ?? '')
    } : undefined;
    let account: WhatsAppAccountRecord & { _id: Types.ObjectId };
    try {
      account = await this.accounts.create({
        tenantId: new Types.ObjectId(currentTenantId()), label: input.label, color: input.color,
        provider, providerConfig, status: 'created', desiredState: 'disconnected'
      });
    } catch (error) {
      if (provider === 'cloud_api' && error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        throw new ConflictException('Cloud phone number is already registered');
      }
      throw error;
    }
    await this.members.create({
      tenantId: account.tenantId, accountId: account._id, userId: new Types.ObjectId(principal.id),
      level: 'manage', grantedBy: new Types.ObjectId(principal.id), grantedAt: new Date()
    });
    await this.access.invalidate(principal.tenantId, principal.id, account._id.toString());
    await this.audit.record(principal.id, 'account.create', 'WhatsAppAccount', account._id.toString());
    return this.view(account);
  }

  async update(principal: Principal, id: string, input: UpdateAccountInput): Promise<AccountView> {
    const account = await this.get(principal, id, 'update');
    account.set(input);
    await account.save();
    await this.audit.record(principal.id, 'account.update', 'WhatsAppAccount', id);
    return this.view(account);
  }

  async setConnection(principal: Principal, id: string, operation: 'connect' | 'disconnect' | 'logout') {
    const account = await this.get(principal, id, 'connect');
    account.desiredState = operation === 'connect' ? 'connected' : 'disconnected';
    if (operation === 'connect') account.status = 'connecting';
    if (operation === 'disconnect') account.status = 'disconnected';
    if (operation === 'logout') account.status = 'logged_out';
    await account.save();
    if (operation !== 'connect') {
      await this.commands.send({ type: operation, accountId: id, tenantId: principal.tenantId });
      if (operation === 'logout') {
        if (!(await this.commands.waitUntilStopped(id, 15_000))) throw new ConflictException('Account session is still stopping');
        await this.authStates.deleteMany({ tenantId: account.tenantId, accountId: account._id });
      }
    }
    await this.audit.record(principal.id, `account.${operation}`, 'WhatsAppAccount', id);
    return this.view(account);
  }

  async syncHistory(principal: Principal, id: string): Promise<{ accepted: true }> {
    const account = await this.get(principal, id, 'connect');
    if (account.provider !== 'baileys') throw new UnprocessableEntityException('History import requires a linked WhatsApp account');
    if (account.status !== 'connected' || account.desiredState !== 'connected') throw new ConflictException('Account must be connected');
    if (!(await this.commands.send({ type: 'sync_history', accountId: id, tenantId: principal.tenantId }))) {
      throw new ServiceUnavailableException('Account session is not running');
    }
    await this.audit.record(principal.id, 'account.history.sync', 'WhatsAppAccount', id);
    return { accepted: true };
  }

  async clearChats(principal: Principal, id: string): Promise<{ deleted: { conversations: number; messages: number; media: number } }> {
    const account = await this.get(principal, id, 'update');
    if (account.provider !== 'baileys') throw new UnprocessableEntityException('History reimport requires a linked WhatsApp account');
    if (account.status !== 'connected' || account.desiredState !== 'connected') throw new ConflictException('Account must be connected');
    const tenantId = new Types.ObjectId(principal.tenantId);

    // Stop the live session before deleting data so an active history request cannot refill it.
    account.desiredState = 'disconnected';
    account.status = 'logged_out';
    await account.save();
    await this.commands.send({ type: 'logout', accountId: id, tenantId: principal.tenantId });
    if (!(await this.commands.waitUntilStopped(id, 15_000))) throw new ConflictException('Account session is still stopping');
    await this.authStates.deleteMany({ tenantId: account.tenantId, accountId: account._id });

    const mediaRecords = await this.media.find({ tenantId, accountId: account._id }).select('storageKey thumbnailKey storageDriver').lean();
    for (const asset of mediaRecords) {
      const storage = this.storage.forDriver(asset['storageDriver'] as 'local' | 's3' | 'hostinger');
      await storage.delete(asset['storageKey'] as string);
      if (asset['thumbnailKey']) await storage.delete(asset['thumbnailKey'] as string);
    }
    await this.media.deleteMany({ tenantId, accountId: account._id });
    const [messageResult, conversationResult] = await Promise.all([
      this.messages.deleteMany({ tenantId, accountId: account._id }),
      this.conversations.deleteMany({ tenantId, accountId: account._id }),
      this.accounts.db.collection('pending_message_mutations').deleteMany({ tenantId, accountId: account._id })
    ]);
    await this.accounts.db.collection('history_cursors').deleteMany({ tenantId, accountId: account._id });
    account.desiredState = 'connected';
    account.status = 'connecting';
    await account.save();
    await this.audit.record(principal.id, 'account.logout', 'WhatsAppAccount', id);
    await this.audit.record(principal.id, 'account.connect', 'WhatsAppAccount', id);
    await this.audit.record(principal.id, 'account.chats.clear', 'WhatsAppAccount', id,
      { conversations: conversationResult.deletedCount, messages: messageResult.deletedCount, media: mediaRecords.length });
    return { deleted: { conversations: conversationResult.deletedCount, messages: messageResult.deletedCount, media: mediaRecords.length } };
  }

  async getQr(principal: Principal, id: string): Promise<{ qr: string | null }> {
    await this.get(principal, id, 'connect');
    const qr = await this.bus.get(`hala:qr:${id}`);
    return { qr };
  }

  async remove(principal: Principal, id: string): Promise<{ ok: true }> {
    const account = await this.get(principal, id, 'delete');
    const dataScope = { tenantId: account.tenantId, accountId: account._id };
    account.desiredState = 'disconnected';
    await account.save();
    await this.commands.send({ type: 'disconnect', accountId: id, tenantId: principal.tenantId });
    if (!(await this.commands.waitUntilStopped(id))) throw new ConflictException('Account session is still stopping');
    const mediaRecords = await this.media.find(dataScope).select('storageKey thumbnailKey storageDriver').lean();
    for (const asset of mediaRecords) {
      const storage = this.storage.forDriver(asset['storageDriver'] as 'local' | 's3' | 'hostinger');
      await storage.delete(asset['storageKey'] as string);
      if (asset['thumbnailKey']) await storage.delete(asset['thumbnailKey'] as string);
    }
    await this.media.deleteMany(dataScope);
    const [messageResult, conversationResult] = await Promise.all([
      this.messages.deleteMany(dataScope), this.conversations.deleteMany(dataScope)
    ]);
    const db = this.accounts.db;
    await Promise.all([
      db.collection('calls').deleteMany(dataScope),
      db.collection('pending_message_mutations').deleteMany(dataScope),
      db.collection('history_cursors').deleteMany(dataScope)
    ]);
    const affected = await this.members.find({ accountId: account._id }).lean();
    await this.members.deleteMany(dataScope);
    await this.authStates.deleteMany(dataScope);
    await this.accounts.deleteOne({ _id: account._id, tenantId: account.tenantId });
    for (const member of affected) await this.access.invalidate(principal.tenantId, member.userId.toString(), id);
    await this.bus.publish({ type: 'account.deleted', tenantId: principal.tenantId, accountId: id });
    await this.audit.record(principal.id, 'account.delete', 'WhatsAppAccount', id,
      { conversations: conversationResult.deletedCount, messages: messageResult.deletedCount, media: mediaRecords.length });
    return { ok: true };
  }

  async listMembers(principal: Principal, id: string) {
    await this.get(principal, id, 'members');
    return this.members.find({ accountId: new Types.ObjectId(id) }).lean();
  }

  async setMember(principal: Principal, id: string, userId: string, level: AccountLevel) {
    await this.get(principal, id, 'members');
    const user = await this.users.findOne({ _id: userId, status: { $in: ['active', 'invited'] } }).lean();
    if (!user) throw new NotFoundException('User not found');
    const member = await this.members.findOneAndUpdate(
      { accountId: new Types.ObjectId(id), userId: new Types.ObjectId(userId) },
      { $set: { level, grantedBy: new Types.ObjectId(principal.id), grantedAt: new Date() }, $setOnInsert: { tenantId: new Types.ObjectId(principal.tenantId) } },
      { upsert: true, returnDocument: 'after' }
    );
    await this.access.invalidate(principal.tenantId, userId, id);
    await this.audit.record(principal.id, 'account.member.grant', 'WhatsAppAccount', id, { userId, level });
    return member;
  }

  async removeMember(principal: Principal, id: string, userId: string): Promise<{ ok: true }> {
    await this.get(principal, id, 'members');
    const existing = await this.members.findOne({ accountId: new Types.ObjectId(id), userId: new Types.ObjectId(userId) });
    if (!existing) throw new NotFoundException('Membership not found');
    await this.members.deleteOne({ _id: existing._id });
    await this.access.invalidate(principal.tenantId, userId, id);
    await this.audit.record(principal.id, 'account.member.revoke', 'WhatsAppAccount', id, { userId });
    return { ok: true };
  }

  async userAccounts(principal: Principal, userId: string) {
    if (principal.id !== userId && !principal.role.permissions.includes('users:read')) throw new ForbiddenException();
    const target = await this.users.findById(userId).lean();
    if (!target) throw new NotFoundException('User not found');
    const memberships = await this.members.find({ userId: new Types.ObjectId(userId) }).lean();
    const ids = memberships.map(member => member.accountId);
    const accounts = await this.accounts.find({ $and: [{ _id: { $in: ids } }, this.scoped(principal, 'read')] }).lean();
    return accounts.map(account => ({ ...this.view(account), level: memberships.find(member => member.accountId.equals(account._id))?.level }));
  }
}
