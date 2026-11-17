import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { environmentSchema } from '@hala/shared';
import { ObserveModule } from './observe.js';
import { WorkerRuntimeService } from './session/worker-runtime.service.js';

@Module({
  imports: [
    ObserveModule.forRoot({ serviceId: 'hala-worker', enabled: Boolean(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET) }),
    ConfigModule.forRoot({ isGlobal: true, validate: input => environmentSchema.parse(input) }),
    LoggerModule.forRoot({ pinoHttp: { autoLogging: false, redact: { paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.cloud.accessToken'
    ], censor: '[REDACTED]' } } })
  ],
  providers: [WorkerRuntimeService]
})
export class WorkerModule {}
