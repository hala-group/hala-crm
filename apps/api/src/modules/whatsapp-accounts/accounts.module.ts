import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AccountsService } from './accounts.service.js';
import { AccountsController, UserAccountsController } from './accounts.controller.js';
import { AccountCommandService } from './account-command.service.js';

@Module({ imports: [PersistenceModule, AuditModule], controllers: [AccountsController, UserAccountsController], providers: [AccountsService, AccountCommandService], exports: [AccountsService, AccountCommandService] })
export class AccountsModule {}
