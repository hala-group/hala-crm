import { Body, Controller, Delete, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { messagePushInstallationSchema, type MessagePushInstallationInput } from '@hala/shared';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { MessagePushService } from './message-push.service.js';

@ApiTags('message-push')
@ApiBearerAuth()
@Controller('message-push')
export class MessagePushController {
  constructor(@Inject(MessagePushService) private readonly push: MessagePushService) {}

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
