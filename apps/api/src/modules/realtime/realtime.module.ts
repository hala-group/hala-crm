import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { CallsModule } from '../calls/calls.module.js';
import { MessagePushModule } from '../message-push/message-push.module.js';

@Module({ imports: [PersistenceModule, CallsModule, MessagePushModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
