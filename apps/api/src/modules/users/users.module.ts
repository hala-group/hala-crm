import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({ imports: [PersistenceModule, AuditModule, AuthModule], controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
