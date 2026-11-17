import { Controller, Get, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { type UserRecord } from '../users/user.schema.js';

@ApiTags('auth')
@ApiBearerAuth()
@Controller()
export class MeController {
  constructor(@InjectModel('User') private readonly users: Model<UserRecord>) {}
  @Get('me')
  @ApiOperation({ summary: 'Get current user, role, permissions, and account memberships' })
  async me(@Req() request: AuthenticatedRequest) {
    const { id, tenantId, email, name, status, role, accountMemberships } = request.principal;
    const user = await this.users.findById(id).select('preferences').lean();
    return { id, tenantId, email, name, status, role, accountMemberships, preferences: user?.preferences };
  }
}
