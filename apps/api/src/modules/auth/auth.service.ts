import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { hash, verify, argon2id } from 'argon2';
import { type LoginInput } from '@hala/shared';
import { validateEnvironment } from '../../config/environment.js';
import { runInTenant } from '../../common/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { type TenantRecord } from '../tenants/tenant.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type InvitationRecord, type RefreshSessionRecord } from './auth.schema.js';
import { type Principal } from '../../common/auth.types.js';
import { AccountAccessService } from '../access/account-access.service.js';

interface AccessClaims { sub: string; tenantId: string; typ: 'access'; sid: string }
interface RefreshClaims { sub: string; tenantId: string; typ: 'refresh'; sid: string; fid: string }

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const ttlSeconds = (ttl: string): number => {
  const value = Number.parseInt(ttl, 10);
  const unit = ttl.at(-1);
  return value * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit as 's' | 'm' | 'h' | 'd'] ?? 1);
};

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('Tenant') private readonly tenants: Model<TenantRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('RefreshSession') private readonly sessions: Model<RefreshSessionRecord>,
    @InjectModel('Invitation') private readonly invitations: Model<InvitationRecord>,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountAccessService) private readonly accountAccess: AccountAccessService
  ) {}

  private async issuePair(userId: string, tenantId: string, familyId: string = randomUUID()) {
    const env = validateEnvironment(process.env);
    const sessionId = new Types.ObjectId();
    const accessClaims: AccessClaims = { sub: userId, tenantId, typ: 'access', sid: sessionId.toString() };
    const refreshClaims: RefreshClaims = { sub: userId, tenantId, typ: 'refresh', sid: sessionId.toString(), fid: familyId };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessClaims, { secret: env.JWT_ACCESS_SECRET, expiresIn: ttlSeconds(env.JWT_ACCESS_TTL) }),
      this.jwt.signAsync(refreshClaims, { secret: env.JWT_REFRESH_SECRET, expiresIn: ttlSeconds(env.JWT_REFRESH_TTL), jwtid: randomUUID() })
    ]);
    await this.sessions.create({
      _id: sessionId,
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      familyId,
      tokenHash: tokenHash(refreshToken),
      expiresAt: new Date(Date.now() + ttlSeconds(env.JWT_REFRESH_TTL) * 1000)
    });
    return { accessToken, refreshToken, expiresIn: ttlSeconds(env.JWT_ACCESS_TTL) };
  }

  async login(input: LoginInput, requestMeta: { ip?: string; userAgent?: string } = {}) {
    const configuredTenantSlug = validateEnvironment(process.env).BOOTSTRAP_TENANT_SLUG;
    const tenantSlug = input.tenantSlug ?? configuredTenantSlug;
    if (!tenantSlug) throw new UnauthorizedException('Invalid credentials');
    const tenant = await this.tenants.findOne({ slug: tenantSlug }).lean();
    if (!tenant) throw new UnauthorizedException('Invalid credentials');
    const tenantId = tenant._id.toString();
    return runInTenant(tenantId, async () => {
      const user = await this.users.findOne({ email: input.email }).select('+passwordHash');
      if (!user || user.status !== 'active' || !user.passwordHash || !(await verify(user.passwordHash, input.password))) {
        throw new UnauthorizedException('Invalid credentials');
      }
      const userId = user._id.toString();
      const pair = await this.issuePair(userId, tenantId);
      await this.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
      await this.audit.record(userId, 'auth.login', 'User', userId);
      return pair;
    }, requestMeta);
  }

  async refresh(token: string) {
    const env = validateEnvironment(process.env);
    let claims: RefreshClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshClaims>(token, { secret: env.JWT_REFRESH_SECRET });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (claims.typ !== 'refresh' || !claims.tenantId || !claims.sid || !claims.fid) throw new UnauthorizedException();
    return runInTenant(claims.tenantId, async () => {
      const session = await this.sessions.findOne({ _id: claims.sid, tokenHash: tokenHash(token) });
      if (!session || session.familyId !== claims.fid || session.expiresAt <= new Date()) throw new UnauthorizedException();
      if (session.usedAt || session.revokedAt) {
        await this.sessions.updateMany({ familyId: claims.fid }, { $set: { revokedAt: new Date() } });
        await this.accountAccess.invalidate(claims.tenantId, claims.sub, '');
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      const user = await this.users.findById(claims.sub).lean();
      if (!user || user.status !== 'active') throw new UnauthorizedException();
      const updated = await this.sessions.findOneAndUpdate(
        { _id: claims.sid, tokenHash: tokenHash(token), usedAt: null, revokedAt: null },
        { $set: { usedAt: new Date() } }, { returnDocument: 'after' }
      );
      if (!updated) {
        await this.sessions.updateMany({ familyId: claims.fid }, { $set: { revokedAt: new Date() } });
        await this.accountAccess.invalidate(claims.tenantId, claims.sub, '');
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      return this.issuePair(claims.sub, claims.tenantId, claims.fid);
    });
  }

  async logout(token: string | undefined, principal: Principal): Promise<void> {
    if (!token) return;
    let claims: RefreshClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshClaims>(token, { secret: validateEnvironment(process.env).JWT_REFRESH_SECRET });
    } catch {
      return; // Invalid or expired cookies are cleared by the controller.
    }
    if (claims.typ !== 'refresh' || claims.sub !== principal.id || claims.tenantId !== principal.tenantId) {
      throw new UnauthorizedException();
    }
    await runInTenant(claims.tenantId, async () =>
      this.sessions.updateMany({ familyId: claims.fid, userId: new Types.ObjectId(claims.sub) }, { $set: { revokedAt: new Date() } })
    );
    await this.accountAccess.invalidate(claims.tenantId, claims.sub, '');
  }

  async createInvitation(userId: string, tenantId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = `${tenantId}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    await this.invitations.create({ tenantId: new Types.ObjectId(tenantId), userId: new Types.ObjectId(userId), tokenHash: tokenHash(token), expiresAt });
    return { token, expiresAt };
  }

  async acceptInvitation(token: string, password: string, requestMeta: { ip?: string; userAgent?: string } = {}): Promise<void> {
    const tenantId = token.split('.')[0];
    if (!tenantId || !Types.ObjectId.isValid(tenantId)) throw new UnauthorizedException('Invalid invitation');
    await runInTenant(tenantId, async () => {
      const passwordHash = await hash(password, { type: argon2id });
      const invitation = await this.invitations.findOneAndUpdate(
        { tokenHash: tokenHash(token), consumedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { consumedAt: new Date() } }, { returnDocument: 'after' }
      );
      if (!invitation) throw new UnauthorizedException('Invalid invitation');
      const result = await this.users.updateOne(
        { _id: invitation.userId, status: 'invited' },
        { $set: { passwordHash, status: 'active' } }
      );
      if (result.modifiedCount !== 1) throw new ConflictException('Invitation already accepted');
      await this.audit.record(invitation.userId.toString(), 'user.accept_invite', 'User', invitation.userId.toString());
    }, requestMeta);
  }

  async changePassword(userId: string, tenantId: string, currentPassword: string, newPassword: string): Promise<void> {
    await runInTenant(tenantId, async () => {
      const user = await this.users.findById(userId).select('+passwordHash');
      if (!user || !user.passwordHash) throw new UnauthorizedException('User not found');
      const matches = await verify(user.passwordHash, currentPassword);
      if (!matches) throw new UnauthorizedException('كلمة المرور الحالية غير صحيحة');
      const newHash = await hash(newPassword, { type: argon2id });
      user.passwordHash = newHash;
      await user.save();
      await this.audit.record(userId, 'auth.password_change', 'User', userId);
    });
  }
}
