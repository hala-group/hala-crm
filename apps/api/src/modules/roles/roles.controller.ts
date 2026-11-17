import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createRoleSchema, idParamsSchema, PERMISSIONS, updateRoleSchema, type CreateRoleInput } from '@hala/shared';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { RolesService } from './roles.service.js';

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @Get()
  @CheckPolicy('roles:read')
  @ApiOperation({ summary: 'List roles in the current tenant' })
  list(@Req() request: AuthenticatedRequest) { return this.roles.list(request.principal); }

  @Post()
  @CheckPolicy('roles:manage')
  @ApiOperation({ summary: 'Create a custom role' })
  @ApiBody({ schema: { type: 'object', required: ['name', 'permissions'], properties: { name: { type: 'string' }, description: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } } })
  create(@Req() request: AuthenticatedRequest, @Body({ schema: createRoleSchema }) body: CreateRoleInput) {
    return this.roles.create(request.principal, body);
  }

  @Patch(':id')
  @CheckPolicy('roles:manage')
  @ApiOperation({ summary: 'Update a custom role' })
  @ApiBody({ schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } } })
  update(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }, @Body({ schema: updateRoleSchema }) body: Partial<CreateRoleInput>) {
    return this.roles.update(request.principal, params.id, body);
  }

  @Delete(':id')
  @CheckPolicy('roles:manage')
  @ApiOperation({ summary: 'Delete an unassigned custom role' })
  remove(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.roles.remove(request.principal, params.id);
  }
}

@ApiTags('roles')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  @Get()
  @CheckPolicy('roles:read')
  @ApiOperation({ summary: 'List available permission keys' })
  list() { return PERMISSIONS; }
}
