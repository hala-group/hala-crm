import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';
import { CallPushService } from './call-push.service.js';

@Module({ imports: [PersistenceModule], controllers: [CallsController], providers: [CallsService, CallPushService], exports: [CallsService, CallPushService] })
export class CallsModule {}
