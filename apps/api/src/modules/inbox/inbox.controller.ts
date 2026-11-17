import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assignConversationSchema, idParamsSchema, inboxListQuerySchema, messageListQuerySchema,
  messageSearchQuerySchema, updateConversationTagsSchema, archiveConversationSchema } from '@hala/shared';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { InboxService } from './inbox.service.js';
import { type Response } from 'express';

@ApiTags('inbox')
@ApiBearerAuth()
@Controller()
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @Get('tags')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'List distinct contact tags for the tenant' })
  tags(@Req() request: AuthenticatedRequest) {
    return this.inbox.getTags(request.principal);
  }

  @Get('messages/search')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Search messages by text content' })
  searchMessages(@Req() request: AuthenticatedRequest, @Query({ schema: messageSearchQuerySchema }) query: unknown) {
    return this.inbox.searchMessages(request.principal, query);
  }

  @Get('conversations')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'List authorized conversations with cursor pagination' })
  list(@Req() request: AuthenticatedRequest, @Query({ schema: inboxListQuerySchema }) query: unknown) {
    return this.inbox.list(request.principal, query);
  }

  @Get('conversations/:id')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Get one authorized conversation' })
  one(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.inbox.getConversationView(request.principal, params.id);
  }

  @Post('conversations/:id/profile/refresh')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Refresh WhatsApp contact about and shared groups for an authorized conversation' })
  refreshProfile(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.inbox.refreshProfile(request.principal, params.id);
  }

  @Get('conversations/:id/media')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'List authorized conversation media with cursor pagination' })
  conversationMedia(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Query({ schema: messageListQuerySchema }) query: unknown) {
    return this.inbox.listConversationMedia(request.principal, params.id, query);
  }

  @Get('conversations/:id/avatar/status')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Get avatar availability for an authorized conversation' })
  avatarStatus(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.inbox.avatarStatus(request.principal, params.id);
  }

  @Post('conversations/:id/avatar/refresh')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Queue a profile picture refresh for an authorized conversation' })
  refreshAvatar(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.inbox.refreshAvatar(request.principal, params.id);
  }

  @Get('conversations/:id/avatar')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Stream the authorized conversation profile picture' })
  async avatar(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Res({ passthrough: true }) response: Response) {
    const asset = await this.inbox.openAvatar(request.principal, params.id);
    response.setHeader('Content-Type', asset.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(asset.stream);
  }

  @Get('conversations/:id/messages')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'List messages for an authorized conversation' })
  messages(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Query({ schema: messageListQuerySchema }) query: unknown) {
    return this.inbox.listMessages(request.principal, params.id, query);
  }

  @Post('conversations/:id/assign')
  @CheckPolicy('conversations:assign')
  @ApiOperation({ summary: 'Assign or unassign an authorized conversation' })
  assign(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: assignConversationSchema }) input: { userId: string | null }) {
    return this.inbox.assign(request.principal, params.id, input.userId);
  }

  @Patch('conversations/:id/tags')
  @CheckPolicy('contacts:update')
  @ApiOperation({ summary: 'Update tags for an authorized conversation contact' })
  updateTags(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: updateConversationTagsSchema }) body: { tags: string[] }) {
    return this.inbox.updateTags(request.principal, params.id, body.tags);
  }

  @Post('conversations/:id/archive')
  @CheckPolicy('conversations:archive')
  @ApiOperation({ summary: 'Archive or unarchive an authorized conversation' })
  archive(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: archiveConversationSchema }) body: { archived: boolean }) {
    return this.inbox.archive(request.principal, params.id, body.archived);
  }

  @Get('media/:id')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Stream authorized media or its thumbnail' })
  async media(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Query('thumbnail') thumbnail: string | undefined, @Res({ passthrough: true }) response: Response) {
    const asset = await this.inbox.openMedia(request.principal, params.id, thumbnail === 'true');
    response.setHeader('Content-Type', asset.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    if (asset.fileName) response.setHeader('Content-Disposition', `inline; filename="${asset.fileName.replace(/["\r\n]/g, '')}"`);
    return new StreamableFile(asset.stream);
  }
}
