import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { InjectConnection } from '@nestjs/mongoose';
import { type Connection } from 'mongoose';
import { RedisBusService } from '../access/redis-bus.service.js';
import { Public } from '../../common/public.decorator.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthCheckService) private readonly health: HealthCheckService,
    @InjectConnection() private readonly mongo: Connection,
    @Inject(RedisBusService) private readonly redis: RedisBusService) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOkResponse({ description: 'API process is ready.' })
  check() {
    return this.health.check([
      async () => ({ mongo: { status: this.mongo.readyState === 1 ? 'up' : 'down' } }),
      async () => ({ redis: { status: await this.redis.ping() ? 'up' : 'down' } })
    ]);
  }
}
