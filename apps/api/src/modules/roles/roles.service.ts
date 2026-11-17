import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { type CreateRoleInput } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { currentTenantId } from '../../common/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { type UserRecord } from '../users/user.schema.js';
import { type RoleRecord } from './role.schema.js';
import { Inject } from '@nestjs/common';

@Injectable()
export class RolesService {
  constructor(
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async list(principal: Principal) {
    return this.roles.find({ $and: [accessibleBy(principal.ability).ofType('Role')] }).sort({ isSystem: -1, name: 1 }).lean();
  }

  async create(principal: Principal, input: CreateRoleInput) {
    if (input.permissions.some(permission => !principal.role.permissions.includes(permission))) {
      throw new ForbiddenException('Cannot grant permissions you do not hold');
    }
    const existing = await this.roles.findOne({ name: input.name });
    if (existing) throw new ConflictException('Role name already exists');
    const role = await this.roles.create({
      tenantId: new Types.ObjectId(currentTenantId()),
      name: input.name, description: input.description, permissions: input.permissions, isSystem: false
    });
    await this.audit.record(principal.id, 'role.create', 'Role', role._id.toString());
    return role;
  }

  async update(principal: Principal, id: string, input: Partial<CreateRoleInput>) {
    const role = await this.roles.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'manage').ofType('Role')] });
    if (!role) throw new NotFoundException();
    if (role.isSystem) throw new ForbiddenException('System roles cannot be edited');
    if (input.permissions?.some(permission => !principal.role.permissions.includes(permission))) {
      throw new ForbiddenException('Cannot grant permissions you do not hold');
    }
    if (input.name && input.name !== role.name && await this.roles.findOne({ name: input.name })) {
      throw new ConflictException('Role name already exists');
    }
    role.set(input);
    await role.save();
    await this.audit.record(principal.id, 'role.update', 'Role', id);
    return role;
  }

  async remove(principal: Principal, id: string): Promise<{ ok: true }> {
    const role = await this.roles.findOne({ $and: [{ _id: id }, accessibleBy(principal.ability, 'manage').ofType('Role')] });
    if (!role) throw new NotFoundException();
    if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted');
    if (await this.users.countDocuments({ roleId: role._id })) throw new ConflictException('Role is assigned to users');
    await this.roles.deleteOne({ _id: role._id });
    await this.audit.record(principal.id, 'role.delete', 'Role', id);
    return { ok: true };
  }
}
