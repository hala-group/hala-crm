import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { type Response } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { messagePushInstallationSchema, messagePushAvatarTokenSchema, type MessagePushInstallationInput } from '@hala/shared';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { MessagePushService } from './message-push.service.js';
import { MessagePushContentService } from './message-push-content.service.js';
import { Public } from '../../common/public.decorator.js';

@ApiTags('message-push')
@ApiBearerAuth()
@Controller('message-push')
export class MessagePushController {
  constructor(@Inject(MessagePushService) private readonly push: MessagePushService,
    @Inject(MessagePushContentService) private readonly content: MessagePushContentService) {}

  @Get('avatar/:token')
  @Public()
  @ApiOperation({ summary: 'Open a short-lived notification avatar after verifying its signature and current recipient access' })
  async avatar(@Param('token', { schema: messagePushAvatarTokenSchema }) token: string,
    @Res({ passthrough: true }) response: Response) {
    const asset = await this.content.openAvatar(token);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!asset) { response.redirect('/assets/imgs/logo.webp'); return; }
    response.setHeader('Content-Type', asset.mimeType);
    return new StreamableFile(asset.stream);
  }

  @Get('config')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Get the public Firebase configuration for message push' })
  @ApiOkResponse({ description: 'Firebase web configuration or an explicit disabled state' })
  config() { return this.push.config(); }

  @Post('installations')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Register this browser installation for message push' })
  @ApiOkResponse({ description: 'Installation registered' })
  subscribe(@Req() request: AuthenticatedRequest,
    @Body({ schema: messagePushInstallationSchema }) input: MessagePushInstallationInput) {
    return this.push.subscribe(request.principal, input.fid);
  }

  @Delete('installations')
  @ApiOperation({ summary: 'Remove this browser installation from message push' })
  @ApiOkResponse({ description: 'Installation removed' })
  unsubscribe(@Req() request: AuthenticatedRequest,
    @Body({ schema: messagePushInstallationSchema }) input: MessagePushInstallationInput) {
    return this.push.unsubscribe(request.principal, input.fid);
  }
}
