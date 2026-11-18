import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { FirebaseMessagingService } from './firebase-messaging.service.js';
import { MessagePushController } from './message-push.controller.js';
import { MessagePushService } from './message-push.service.js';

@Module({ imports: [PersistenceModule], controllers: [MessagePushController],
  providers: [FirebaseMessagingService, MessagePushService], exports: [MessagePushService] })
export class MessagePushModule {}
