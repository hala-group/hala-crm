import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PermissionsController, RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

@Module({ imports: [PersistenceModule, AuditModule], controllers: [RolesController, PermissionsController], providers: [RolesService] })
export class RolesModule {}
