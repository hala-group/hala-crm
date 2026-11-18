import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { FirebaseMessagingService } from './firebase-messaging.service.js';
import { MessagePushController } from './message-push.controller.js';
import { MessagePushService } from './message-push.service.js';
import { MessagePushContentService } from './message-push-content.service.js';
import { AccountsModule } from '../whatsapp-accounts/accounts.module.js';

@Module({ imports: [PersistenceModule, AccountsModule], controllers: [MessagePushController],
  providers: [FirebaseMessagingService, MessagePushService, MessagePushContentService], exports: [MessagePushService] })
export class MessagePushModule {}
