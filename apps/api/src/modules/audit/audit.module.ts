import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

@Module({ imports: [PersistenceModule], controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
