import { Body, Controller, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { acceptInviteSchema, changePasswordSchema, loginSchema, type ChangePasswordInput, type LoginInput } from '@hala/shared';
import { Public } from '../../common/public.decorator.js';
import { validateEnvironment } from '../../config/environment.js';
import { AuthService } from './auth.service.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';

function setRefreshCookie(response: Response, token: string): void {
  const env = validateEnvironment(process.env);
  const amount = Number.parseInt(env.JWT_REFRESH_TTL, 10);
  const unit = env.JWT_REFRESH_TTL.at(-1);
  const maxAge = amount * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 's' | 'm' | 'h' | 'd'] ?? 1000);
  response.cookie('hala_refresh', token, {
    httpOnly: true, sameSite: 'strict', secure: env.NODE_ENV === 'production',
    path: '/api/v1/auth', maxAge
  });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Sign in to a tenant' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: {
    tenantSlug: { type: 'string', description: 'Optional tenant override; defaults to BOOTSTRAP_TENANT_SLUG.' },
    email: { type: 'string' }, password: { type: 'string' }
  } } })
  async login(@Body({ schema: loginSchema }) body: LoginInput, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const pair = await this.auth.login(body, { ip: request.ip, userAgent: request.headers['user-agent'] });
    setRefreshCookie(response, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = request.cookies?.hala_refresh as string | undefined;
    if (!token) throw new UnauthorizedException();
    const pair = await this.auth.refresh(token);
    setRefreshCookie(response, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the refresh family and clear the cookie' })
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.cookies?.hala_refresh as string | undefined, request.principal);
    response.clearCookie('hala_refresh', { path: '/api/v1/auth' });
    return { ok: true };
  }

  @Post('change-password')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password for current user' })
  @ApiBody({ schema: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } } } })
  async changePassword(@Req() request: AuthenticatedRequest, @Body({ schema: changePasswordSchema }) body: ChangePasswordInput) {
    await this.auth.changePassword(request.principal.id, request.principal.tenantId, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Public()
  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept a one-use invitation and set a password' })
  @ApiBody({ schema: { type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string' } } } })
  async acceptInvite(@Body({ schema: acceptInviteSchema }) body: { token: string; password: string }, @Req() request: Request) {
    await this.auth.acceptInvitation(body.token, body.password, { ip: request.ip, userAgent: request.headers['user-agent'] });
    return { ok: true };
  }

}
