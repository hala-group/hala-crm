import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { MeController } from './me.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [PersistenceModule, AuditModule],
  controllers: [AuthController, MeController],
  providers: [AuthService],
  exports: [AuthService]
})
export class AuthModule {}
