import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { CallsModule } from '../calls/calls.module.js';

@Module({ imports: [PersistenceModule, CallsModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
