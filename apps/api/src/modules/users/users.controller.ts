import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createUserSchema, idParamsSchema, inviteUserSchema, updateUserSchema, type CreateUserInput, type InviteUserInput } from '@hala/shared';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @CheckPolicy('users:read')
  @ApiOperation({ summary: 'List users in the current tenant' })
  list(@Req() request: AuthenticatedRequest) { return this.users.list(request.principal); }

  @Post()
  @CheckPolicy('users:create')
  @ApiOperation({ summary: 'Create an active user directly with default password 123456' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'name', 'roleId'], properties: { email: { type: 'string' }, name: { type: 'string' }, roleId: { type: 'string' } } } })
  create(@Req() request: AuthenticatedRequest, @Body({ schema: createUserSchema }) body: CreateUserInput) {
    return this.users.create(request.principal, body);
  }

  @Post('invite')
  @CheckPolicy('users:create')
  @ApiOperation({ summary: 'Invite a user or renew an invitation' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'name', 'roleId'], properties: { email: { type: 'string' }, name: { type: 'string' }, roleId: { type: 'string' } } } })
  invite(@Req() request: AuthenticatedRequest, @Body({ schema: inviteUserSchema }) body: InviteUserInput) {
    return this.users.invite(request.principal, body);
  }

  @Patch(':id')
  @CheckPolicy('users:update')
  @ApiOperation({ summary: 'Update a user name or role' })
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string' }, roleId: { type: 'string' }, status: { type: 'string', enum: ['active', 'suspended'] } } } })
  update(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }, @Body({ schema: updateUserSchema }) body: { name?: string; roleId?: string; status?: 'active' | 'suspended' }) {
    return this.users.update(request.principal, params.id, body);
  }

  @Post(':id/suspend')
  @CheckPolicy('users:update')
  @ApiOperation({ summary: 'Suspend a user and revoke their sessions' })
  suspend(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.users.suspend(request.principal, params.id);
  }

  @Delete(':id')
  @CheckPolicy('users:delete')
  @ApiOperation({ summary: 'Delete a user and revoke their sessions' })
  remove(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.users.remove(request.principal, params.id);
  }
}
