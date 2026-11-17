import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckPolicy } from '../../common/check-policy.decorator.js';
import { type AuthenticatedRequest } from '../../common/auth.types.js';
import { AuditService } from './audit.service.js';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @CheckPolicy('audit:read')
  @ApiOperation({ summary: 'List tenant audit entries visible to the current role' })
  list(@Req() request: AuthenticatedRequest) {
    return this.audit.list(request.principal);
  }
}
