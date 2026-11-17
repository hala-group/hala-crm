import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { MediaUploadService } from './media-upload.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { AccountsModule } from '../whatsapp-accounts/accounts.module.js';

@Module({ imports: [PersistenceModule, AuditModule, AccountsModule], controllers: [InboxController, MessagesController],
  providers: [InboxService, MessagesService, MediaUploadService] })
export class InboxModule {}
