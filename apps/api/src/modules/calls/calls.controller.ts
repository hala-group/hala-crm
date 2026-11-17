import { Body, Controller, Delete, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { callPushSubscriptionSchema, removeCallPushSubscriptionSchema, type CallPushSubscriptionInput } from '@hala/shared';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { CallsService } from './calls.service.js';
import { CallPushService } from './call-push.service.js';

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(@Inject(CallsService) private readonly calls: CallsService,
    @Inject(CallPushService) private readonly push: CallPushService) {}

  @Get()
  @CheckPolicy('calls:read')
  @ApiOperation({ summary: 'List calls on authorized WhatsApp numbers' })
  list(@Req() request: AuthenticatedRequest) {
    return this.calls.list(request.principal);
  }

  @Get('push-key')
  @CheckPolicy('calls:read')
  @ApiOperation({ summary: 'Get the public VAPID key for call alerts' })
  pushKey() { return this.push.key(); }

  @Post('subscriptions')
  @CheckPolicy('calls:read')
  @ApiOperation({ summary: 'Register a browser for authorized call push alerts' })
  subscribe(@Req() request: AuthenticatedRequest,
    @Body({ schema: callPushSubscriptionSchema }) input: CallPushSubscriptionInput) {
    return this.push.subscribe(request.principal, input);
  }

  @Delete('subscriptions')
  @CheckPolicy('calls:read')
  @ApiOperation({ summary: 'Remove a browser call push subscription' })
  unsubscribe(@Req() request: AuthenticatedRequest,
    @Body({ schema: removeCallPushSubscriptionSchema }) input: { endpoint: string }) {
    return this.push.unsubscribe(request.principal, input.endpoint);
  }
}
