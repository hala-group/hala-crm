import { Body, Controller, Delete, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { deleteMessageQuerySchema, editMessageSchema, forwardMessageSchema, idParamsSchema,
  outgoingMessageSchema, uploadMediaSchema, type OutgoingMessageInput } from '@hala/shared';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { MediaUploadService } from './media-upload.service.js';
import { MessagesService } from './messages.service.js';

@ApiTags('messages')
@ApiBearerAuth()
@Controller()
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(MediaUploadService) private readonly uploadService: MediaUploadService) {}

  @Post('messages')
  @CheckPolicy('messages:send')
  @ApiOperation({ summary: 'Queue one idempotent outbound WhatsApp message' })
  @ApiBody({ schema: { type: 'object', required: ['type', 'accountId', 'clientMessageId'] } })
  send(@Req() request: AuthenticatedRequest, @Body({ schema: outgoingMessageSchema }) body: OutgoingMessageInput) {
    return this.messages.send(request.principal, body);
  }

  @Patch('messages/:id')
  @CheckPolicy('messages:edit')
  @ApiOperation({ summary: 'Edit an outgoing text message within the WhatsApp edit window' })
  edit(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: editMessageSchema }) body: { text: string }) {
    return this.messages.edit(request.principal, params.id, body.text);
  }

  @Delete('messages/:id')
  @CheckPolicy('messages:delete')
  @ApiOperation({ summary: 'Delete a message locally or revoke it for everyone' })
  remove(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Query({ schema: deleteMessageQuerySchema }) query: { scope: 'me' | 'everyone' }) {
    return this.messages.remove(request.principal, params.id, query.scope);
  }

  @Post('messages/:id/forward')
  @CheckPolicy('messages:send')
  @ApiOperation({ summary: 'Forward a message to authorized conversations' })
  forward(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string },
    @Body({ schema: forwardMessageSchema }) body: { conversationIds: string[] }) {
    return this.messages.forward(request.principal, params.id, body.conversationIds);
  }

  @Post('messages/:id/retry')
  @CheckPolicy('messages:send')
  @ApiOperation({ summary: 'Retry a failed outbound message with its original client ID' })
  retry(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.messages.retry(request.principal, params.id);
  }

  @Post('conversations/:id/read')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Mark an authorized conversation as read' })
  read(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.messages.markRead(request.principal, params.id);
  }

  @Post('conversations/:id/unread')
  @CheckPolicy('conversations:read')
  @ApiOperation({ summary: 'Mark an authorized conversation as unread' })
  unread(@Req() request: AuthenticatedRequest, @Param({ schema: idParamsSchema }) params: { id: string }) {
    return this.messages.markUnread(request.principal, params.id);
  }

  @Post('media/upload')
  @CheckPolicy('messages:send_media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Validate, process and store WhatsApp media for a number' })
  @ApiBody({ schema: { type: 'object', required: ['accountId', 'kind', 'file'], properties: {
    accountId: { type: 'string' }, kind: { type: 'string' }, file: { type: 'string', format: 'binary' }
  } } })
  upload(@Req() request: AuthenticatedRequest, @Body({ schema: uploadMediaSchema }) body: { accountId: string; kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' },
    @UploadedFile() file: Express.Multer.File) {
    return this.uploadService.upload(request.principal, body.accountId, body.kind, file);
  }
}
