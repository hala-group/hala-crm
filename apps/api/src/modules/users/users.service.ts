import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { hash, argon2id } from 'argon2';
import { type CreateUserInput, type InviteUserInput } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { currentTenantId } from '../../common/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { type RefreshSessionRecord } from '../auth/auth.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from './user.schema.js';
import { AccountAccessService } from '../access/account-access.service.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('RefreshSession') private readonly sessions: Model<RefreshSessionRecord>,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountAccessService) private readonly accountAccess: AccountAccessService
  ) {}

  private async assignableRole(principal: Principal, roleId: string) {
    const role = await this.roles.findById(roleId).lean();
    if (!role) throw new NotFoundException('Role not found');
    if (role.key === 'owner' && principal.role.key !== 'owner') throw new ForbiddenException('Only an owner can assign the owner role');
    if (role.permissions.some(permission => !principal.role.permissions.includes(permission))) {
      throw new ForbiddenException('Cannot assign a more privileged role');
    }
    return role;
  }

  private async assertNotLastOwner(user: UserRecord & { _id: Types.ObjectId }): Promise<void> {
    if (user.status !== 'active') return;
    const owner = await this.roles.findOne({ key: 'owner' });
    if (!owner || !user.roleId.equals(owner._id)) return;
    const activeOwners = await this.users.countDocuments({ roleId: owner._id, status: 'active' });
    if (activeOwners <= 1) throw new ForbiddenException('Cannot remove the last owner');
  }

  list(principal: Principal) {
    return this.users.find({ $and: [accessibleBy(principal.ability).ofType('User')] }).sort({ name: 1 }).lean();
  }

  async create(principal: Principal, input: CreateUserInput) {
    await this.assignableRole(principal, input.roleId);
    const existing = await this.users.findOne({ email: input.email });
    if (existing) throw new ConflictException('User already exists');
    const passwordHash = await hash('123456', { type: argon2id });
    const user = await this.users.create({
      tenantId: new Types.ObjectId(currentTenantId()),
      email: input.email,
      name: input.name,
      roleId: new Types.ObjectId(input.roleId),
      passwordHash,
      status: 'active'
    });
    await this.audit.record(principal.id, 'user.create', 'User', user._id.toString());
    return {
      _id: user._id.toString(),
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      status: user.status,
      roleId: user.roleId.toString()
    };
  }

  async invite(principal: Principal, input: InviteUserInput) {
    await this.assignableRole(principal, input.roleId);
    let user = await this.users.findOne({ email: input.email });
    if (user && user.status !== 'invited') throw new ConflictException('User already exists');
    if (user) {
      user.name = input.name;
      user.roleId = new Types.ObjectId(input.roleId);
      await user.save();
    } else {
      user = await this.users.create({
        tenantId: new Types.ObjectId(currentTenantId()),
        email: input.email, name: input.name, roleId: new Types.ObjectId(input.roleId), status: 'invited'
      });
    }
    const invitation = await this.auth.createInvitation(user._id.toString(), principal.tenantId);
    await this.audit.record(principal.id, 'user.invite', 'User', user._id.toString());
    return { user: { id: user._id.toString(), email: user.email, name: user.name, status: user.status, roleId: user.roleId.toString() }, invitation };
  }

  async update(principal: Principal, id: string, input: { name?: string; roleId?: string; status?: 'active' | 'suspended' }) {
    const user = await this.users.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'update').ofType('User')] });
    if (!user) throw new NotFoundException();
    if (input.roleId && input.roleId !== user.roleId.toString()) {
      await this.assignableRole(principal, input.roleId);
      await this.assertNotLastOwner(user);
      user.roleId = new Types.ObjectId(input.roleId);
    }
    if (input.name) user.name = input.name;
    if (input.status && input.status !== user.status) {
      if (user.status === 'invited') throw new ForbiddenException('Invitation must be accepted first');
      if (input.status === 'suspended') await this.assertNotLastOwner(user);
      user.status = input.status;
      if (input.status === 'suspended') {
        await this.sessions.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
      }
    }
    await user.save();
    if (input.roleId || input.status) await this.accountAccess.invalidate(principal.tenantId, id, '');
    await this.audit.record(principal.id, 'user.update', 'User', id);
    return { id: user._id.toString(), email: user.email, name: user.name, roleId: user.roleId.toString(), status: user.status };
  }

  async suspend(principal: Principal, id: string) {
    const user = await this.users.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'update').ofType('User')] });
    if (!user) throw new NotFoundException();
    await this.assertNotLastOwner(user);
    user.status = 'suspended';
    await user.save();
    await this.sessions.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.accountAccess.invalidate(principal.tenantId, id, '');
    await this.audit.record(principal.id, 'user.suspend', 'User', id);
    return { ok: true };
  }

  async remove(principal: Principal, id: string) {
    const user = await this.users.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'delete').ofType('User')] });
    if (!user) throw new NotFoundException();
    await this.assertNotLastOwner(user);
    await this.sessions.updateMany({ userId: user._id }, { $set: { revokedAt: new Date() } });
    await this.users.deleteOne({ _id: user._id });
    await this.accountAccess.invalidate(principal.tenantId, id, '');
    await this.audit.record(principal.id, 'user.delete', 'User', id);
    return { ok: true };
  }
}
