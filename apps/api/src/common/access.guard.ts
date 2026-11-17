import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { defineAbilityFor, isPermission } from '@hala/shared';
import { validateEnvironment } from '../config/environment.js';
import { enterTenant } from './tenant-context.js';
import { IS_PUBLIC } from './public.decorator.js';
import { type AuthenticatedRequest } from './auth.types.js';
import { type UserRecord } from '../modules/users/user.schema.js';
import { type RoleRecord } from '../modules/roles/role.schema.js';
import { type RefreshSessionRecord } from '../modules/auth/auth.schema.js';
import { AccountAccessService } from '../modules/access/account-access.service.js';

interface AccessClaims { sub: string; tenantId: string; typ: string; sid: string }

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('RefreshSession') private readonly sessions: Model<RefreshSessionRecord>,
    @Inject(AccountAccessService) private readonly accountAccess: AccountAccessService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException();
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token, { secret: validateEnvironment(process.env).JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException();
    }
    if (claims.typ !== 'access' || !claims.tenantId || !claims.sub || !claims.sid) throw new UnauthorizedException();
    enterTenant(claims.tenantId, { ip: request.ip, userAgent: request.headers['user-agent'] });
    const session = await this.sessions.findOne({ _id: claims.sid, userId: claims.sub, revokedAt: null }).lean();
    if (!session || session.expiresAt <= new Date()) throw new UnauthorizedException();
    const user = await this.users.findById(claims.sub).lean();
    if (!user || user.status !== 'active' || user.tenantId.toString() !== claims.tenantId) throw new UnauthorizedException();
    const role = await this.roles.findById(user.roleId).lean();
    if (!role) throw new UnauthorizedException();
    const permissions = role.permissions.filter(isPermission);
    const id = user._id.toString();
    const access = await this.accountAccess.resolve(claims.tenantId, id, permissions);
    const memberships = [...access.accounts].map(([accountId, level]) => ({ accountId, level }));
    request.principal = {
      id,
      tenantId: claims.tenantId,
      email: user.email,
      name: user.name,
      status: 'active',
      role: { id: role._id.toString(), name: role.name, key: role.key, permissions },
      ability: defineAbilityFor({ id, tenantId: claims.tenantId }, { permissions }, memberships),
      accountMemberships: memberships
    };
    return true;
  }
}
