import { Global, Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AccountAccessService } from './account-access.service.js';
import { RedisBusService } from './redis-bus.service.js';

@Global()
@Module({ imports: [PersistenceModule], providers: [AccountAccessService, RedisBusService], exports: [AccountAccessService, RedisBusService] })
export class AccessModule {}
