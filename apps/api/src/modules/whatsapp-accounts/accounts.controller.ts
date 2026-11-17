import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { accountIdSchema, confirmClearChatsSchema, createAccountSchema, idParamsSchema, objectIdSchema, setAccountMemberSchema, updateAccountSchema,
  type CreateAccountInput, type UpdateAccountInput, type AccountLevel } from '@hala/shared';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { AccountsService } from './accounts.service.js';

@ApiTags('whatsapp accounts')
@ApiBearerAuth()
@Controller('whatsapp/accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  @CheckPolicy('accounts:read')
  @ApiOperation({ summary: 'List only WhatsApp numbers accessible to this user' })
  list(@Req() request: AuthenticatedRequest) { return this.accounts.list(request.principal); }

  @Post()
  @CheckPolicy('accounts:create')
  @ApiOperation({ summary: 'Create a WhatsApp number with creator manage membership' })
  @ApiBody({ schema: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, color: { type: 'string' }, provider: { type: 'string', enum: ['baileys', 'cloud_api'] }, cloud: { type: 'object', required: ['phoneNumberId', 'wabaId', 'accessToken'], properties: { phoneNumberId: { type: 'string' }, wabaId: { type: 'string' }, accessToken: { type: 'string' } } } } } })
  create(@Req() request: AuthenticatedRequest, @Body({ schema: createAccountSchema }) body: CreateAccountInput) {
    return this.accounts.create(request.principal, body);
  }

  @Get(':id')
  @CheckPolicy('accounts:read')
  @ApiOperation({ summary: 'Get an accessible WhatsApp number' })
  async get(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.details(request.principal, params.id);
  }

  @Patch(':id')
  @CheckPolicy('accounts:update')
  @ApiOperation({ summary: 'Update WhatsApp number label or color' })
  @ApiBody({ schema: { type: 'object', properties: { label: { type: 'string' }, color: { type: 'string' } } } })
  update(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }, @Body({ schema: updateAccountSchema }) body: UpdateAccountInput) {
    return this.accounts.update(request.principal, params.id, body);
  }

  @Delete(':id')
  @CheckPolicy('accounts:delete')
  @ApiOperation({ summary: 'Delete a WhatsApp number and its session credentials' })
  remove(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.remove(request.principal, params.id);
  }

  @Get(':id/qr')
  @CheckPolicy('accounts:connect')
  @ApiOperation({ summary: 'Get active QR code for a WhatsApp account' })
  getQr(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.getQr(request.principal, params.id);
  }

  @Post(':id/connect')
  @CheckPolicy('accounts:connect')
  @ApiOperation({ summary: 'Request a WhatsApp session' })
  connect(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.setConnection(request.principal, params.id, 'connect');
  }

  @Post(':id/disconnect')
  @CheckPolicy('accounts:connect')
  @ApiOperation({ summary: 'Disconnect a WhatsApp session without removing credentials' })
  disconnect(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.setConnection(request.principal, params.id, 'disconnect');
  }

  @Post(':id/sync-history')
  @CheckPolicy('accounts:connect')
  @ApiOperation({ summary: 'Request available WhatsApp history for a connected Baileys account' })
  syncHistory(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.syncHistory(request.principal, params.id);
  }

  @Delete(':id/chats')
  @CheckPolicy('accounts:update')
  @ApiOperation({ summary: 'Delete all conversations and messages for one WhatsApp number' })
  clearChats(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: confirmClearChatsSchema }) _body: { confirm: true }) {
    return this.accounts.clearChats(request.principal, params.id);
  }

  @Post(':id/logout')
  @CheckPolicy('accounts:connect')
  @ApiOperation({ summary: 'Log out a WhatsApp session and remove credentials' })
  logout(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.setConnection(request.principal, params.id, 'logout');
  }

  @Get(':id/members')
  @CheckPolicy('accounts:members')
  @ApiOperation({ summary: 'List users assigned to this number' })
  members(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.listMembers(request.principal, params.id);
  }

  @Put(':id/members/:userId')
  @CheckPolicy('accounts:members')
  @ApiOperation({ summary: 'Grant or change per-number access' })
  @ApiBody({ schema: { type: 'object', required: ['level'], properties: { level: { type: 'string', enum: ['view', 'reply', 'manage'] } } } })
  setMember(@Req() request: AuthenticatedRequest, @Param('id', { schema: accountIdSchema }) id: string,
    @Param('userId', { schema: objectIdSchema }) userId: string, @Body({ schema: setAccountMemberSchema }) body: { level: AccountLevel }) {
    return this.accounts.setMember(request.principal, id, userId, body.level);
  }

  @Delete(':id/members/:userId')
  @CheckPolicy('accounts:members')
  @ApiOperation({ summary: 'Revoke per-number access' })
  removeMember(@Req() request: AuthenticatedRequest, @Param('id', { schema: accountIdSchema }) id: string,
    @Param('userId', { schema: objectIdSchema }) userId: string) {
    return this.accounts.removeMember(request.principal, id, userId);
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UserAccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get(':id/accounts')
  @ApiOperation({ summary: 'List accessible numbers assigned to a user' })
  list(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.accounts.userAccounts(request.principal, params.id);
  }
}
